#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "common/monitor.h"
#include "ft8/constants.h"
#include "ft8/decode.h"
#include "ft8/encode.h"
#include "ft8/message.h"

#define DIGIDX_MIN_SCORE 10
#define DIGIDX_MAX_CANDIDATES 140
#define DIGIDX_LDPC_ITERATIONS 25
#define DIGIDX_CALLSIGN_HASHTABLE_SIZE 256

typedef struct {
    float freq_hz;
    float time_sec;
    float snr_db;
    char text[40];
} digidx_ft8_decode_t;

static struct {
    char callsign[12];
    uint32_t hash;
} g_callsign_hashtable[DIGIDX_CALLSIGN_HASHTABLE_SIZE];

static void digidx_hashtable_cleanup(uint8_t max_age) {
    for (int i = 0; i < DIGIDX_CALLSIGN_HASHTABLE_SIZE; ++i) {
        if (g_callsign_hashtable[i].callsign[0] != '\0') {
            uint8_t age = (uint8_t)(g_callsign_hashtable[i].hash >> 24);
            if (age > max_age) {
                g_callsign_hashtable[i].callsign[0] = '\0';
                g_callsign_hashtable[i].hash = 0;
            } else {
                g_callsign_hashtable[i].hash =
                    (((uint32_t)age + 1u) << 24) | (g_callsign_hashtable[i].hash & 0x3FFFFFu);
            }
        }
    }
}

static void digidx_hashtable_add(const char *callsign, uint32_t hash) {
    uint16_t hash10 = (hash >> 12) & 0x3FFu;
    int idx = (hash10 * 23) % DIGIDX_CALLSIGN_HASHTABLE_SIZE;
    for (int probe = 0; probe < DIGIDX_CALLSIGN_HASHTABLE_SIZE; ++probe) {
        if (g_callsign_hashtable[idx].callsign[0] == '\0') {
            break;
        }
        if (((g_callsign_hashtable[idx].hash & 0x3FFFFFu) == hash) &&
            (strcmp(g_callsign_hashtable[idx].callsign, callsign) == 0)) {
            g_callsign_hashtable[idx].hash &= 0x3FFFFFu;
            return;
        }
        idx = (idx + 1) % DIGIDX_CALLSIGN_HASHTABLE_SIZE;
    }
    if (g_callsign_hashtable[idx].callsign[0] == '\0') {
        strncpy(g_callsign_hashtable[idx].callsign, callsign, 11);
        g_callsign_hashtable[idx].callsign[11] = '\0';
        g_callsign_hashtable[idx].hash = hash & 0x3FFFFFu;
    }
}

static bool digidx_hashtable_lookup(ftx_callsign_hash_type_t hash_type, uint32_t hash, char *callsign) {
    uint8_t shift = (hash_type == FTX_CALLSIGN_HASH_10_BITS)
                        ? 12
                        : (hash_type == FTX_CALLSIGN_HASH_12_BITS ? 10 : 0);
    uint16_t hash10 = (hash >> (12 - shift)) & 0x3FFu;
    int idx = (hash10 * 23) % DIGIDX_CALLSIGN_HASHTABLE_SIZE;
    for (int probe = 0; probe < DIGIDX_CALLSIGN_HASHTABLE_SIZE; ++probe) {
        if (g_callsign_hashtable[idx].callsign[0] == '\0') {
            break;
        }
        if (((g_callsign_hashtable[idx].hash & 0x3FFFFFu) >> shift) == hash) {
            strcpy(callsign, g_callsign_hashtable[idx].callsign);
            return true;
        }
        idx = (idx + 1) % DIGIDX_CALLSIGN_HASHTABLE_SIZE;
    }
    callsign[0] = '\0';
    return false;
}

float digidx_erff(float x) {
    return erff(x);
}

int digidx_ft8_encode_tones(const char *message, uint8_t out_tones[FT8_NN]) {
    if (message == NULL || out_tones == NULL) {
        return -1;
    }
    ftx_message_t msg;
    ftx_message_init(&msg);
    ftx_message_rc_t rc = ftx_message_encode(&msg, NULL, message);
    if (rc != FTX_MESSAGE_RC_OK) {
        return (int)rc;
    }
    ft8_encode(msg.payload, out_tones);
    return 0;
}

int digidx_ft8_decode_slot(
    const float *samples,
    int num_samples,
    int sample_rate,
    float f_min,
    float f_max,
    digidx_ft8_decode_t *out_decodes,
    int max_decodes
) {
    if (samples == NULL || out_decodes == NULL || num_samples <= 0 || sample_rate <= 0 || max_decodes <= 0) {
        return -1;
    }

    ftx_callsign_hash_interface_t hash_if = {
        .lookup_hash = digidx_hashtable_lookup,
        .save_hash = digidx_hashtable_add,
    };

    monitor_config_t mon_cfg = {
        .f_min = f_min,
        .f_max = f_max,
        .sample_rate = sample_rate,
        .time_osr = 2,
        .freq_osr = 2,
        .protocol = FTX_PROTOCOL_FT8,
    };

    monitor_t mon;
    monitor_init(&mon, &mon_cfg);

    for (int pos = 0; pos + mon.block_size <= num_samples; pos += mon.block_size) {
        if (mon.wf.num_blocks >= mon.wf.max_blocks) {
            break;
        }
        monitor_process(&mon, samples + pos);
    }

    const ftx_waterfall_t *wf = &mon.wf;
    ftx_candidate_t candidates[DIGIDX_MAX_CANDIDATES];
    int num_candidates = ftx_find_candidates(wf, DIGIDX_MAX_CANDIDATES, candidates, DIGIDX_MIN_SCORE);

    ftx_message_t seen[DIGIDX_MAX_CANDIDATES];
    int seen_count = 0;
    int out_count = 0;

    for (int i = 0; i < num_candidates && out_count < max_decodes; ++i) {
        const ftx_candidate_t *cand = &candidates[i];
        ftx_message_t msg;
        ftx_decode_status_t status;
        if (!ftx_decode_candidate(wf, cand, DIGIDX_LDPC_ITERATIONS, &msg, &status)) {
            continue;
        }

        bool duplicate = false;
        for (int j = 0; j < seen_count; ++j) {
            if (seen[j].hash == msg.hash &&
                memcmp(seen[j].payload, msg.payload, sizeof(msg.payload)) == 0) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) {
            continue;
        }
        if (seen_count < DIGIDX_MAX_CANDIDATES) {
            seen[seen_count++] = msg;
        }

        char text[FTX_MAX_MESSAGE_LENGTH + 4];
        memset(text, 0, sizeof(text));
        ftx_message_offsets_t offsets;
        ftx_message_rc_t unpack_rc = ftx_message_decode(&msg, &hash_if, text, &offsets);
        if (unpack_rc != FTX_MESSAGE_RC_OK) {
            continue;
        }

        float freq_hz =
            (mon.min_bin + cand->freq_offset + (float)cand->freq_sub / (float)wf->freq_osr) /
            mon.symbol_period;
        float time_sec =
            (cand->time_offset + (float)cand->time_sub / (float)wf->time_osr) * mon.symbol_period;
        float snr_db = (float)cand->score * 0.5f - 24.0f;
        if (snr_db < -24.0f) {
            snr_db = -24.0f;
        }
        if (snr_db > 24.0f) {
            snr_db = 24.0f;
        }

        out_decodes[out_count].freq_hz = freq_hz;
        out_decodes[out_count].time_sec = time_sec;
        out_decodes[out_count].snr_db = snr_db;
        strncpy(out_decodes[out_count].text, text, sizeof(out_decodes[out_count].text) - 1);
        out_decodes[out_count].text[sizeof(out_decodes[out_count].text) - 1] = '\0';
        out_count++;
    }

    digidx_hashtable_cleanup(10);
    monitor_free(&mon);
    return out_count;
}
