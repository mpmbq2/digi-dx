# FT8 Message Types from data/01_raw/ALL.TXT

This document outlines the main types of FT8 messages found in the provided data file. Each message type has a specific purpose in an amateur radio contact (QSO).

## 1. General Call (CQ)

This is a general call made by a station wishing to make contact with any other station.

* **Format:** `CQ <CALLSIGN> <GRID>` or `CQ DX <CALLSIGN> <GRID>`
* **Purpose:** To initiate a contact. `CQ DX` is used to call stations far away.
* **Examples:**
  * `CQ KF0SUI EM48`
  * `CQ ZW5B GG54`
  * `CQ DX IZ8VYU JN71`

## 2. Directed Call / Response

This message is a direct response to a CQ call, or a specific call to another station.

* **Format:** `<CALLER_CALLSIGN> <CALLED_CALLSIGN> <GRID>`
* **Purpose:** To respond to a station that has called CQ, or to call a specific station.
* **Examples:**
  * `ZW5B KF0SUI EM48`
  * `MW3FLI KF0SUI EM48`
  * `ON7TA KF0SUI EM48`

## 3. Signal Report

Stations exchange signal reports to indicate how well they are receiving each other. The report is a number in decibels (dB).

* **Format:** `<CALLER_CALLSIGN> <CALLED_CALLSIGN> <SIGNAL_REPORT>`
* **Purpose:** To exchange reception quality information. The signal report can be a negative or positive number (e.g., `-15`, `+05`).
* **Examples:**
  * `W9OAA ZW5B -15`
  * `AC3IE ZW5B -11`
  * `K4RW ZW5B +05`

## 4. Roger Report (RR73 / RRR)

This message acknowledges the receipt of a signal report and often serves as a closing salutation.

* **Format:** `<CALLER_CALLSIGN> <CALLED_CALLSIGN> RR73` or `<CALLER_CALLSIGN> <CALLED_CALLSIGN> RRR`
* **Purpose:** To confirm that the signal report was received and to begin ending the contact.
* **Examples:**
  * `W2UH ZW5B RR73`
  * `AC3IE ZW5B RR73`
  * `WX1JT YU1EA RR73`

## 5. Confirmation / Goodbye (73)

This is the final message in a standard contact, serving as a final "goodbye."

* **Format:** `<CALLER_CALLSIGN> <CALLED_CALLSIGN> 73`
* **Purpose:** To end the contact.
* **Examples:**
  * `ZW5B W2FLY 73`
  * `CX4DAE I2KBD 73`
  * `AK6Q LZ1LZ 73`

## 6. Roger + Signal Report (R+Signal)

This message combines the acknowledgment of a received report with sending a new signal report.

* **Format:** `<CALLER_CALLSIGN> <CALLED_CALLSIGN> R<SIGNAL_REPORT>`
* **Purpose:** To make the exchange more efficient by combining two steps into one message.
* **Examples:**
  * `V31DL IZ2QDC R+05`
  * `SM4DHT EA3HMM R-01`
  * `UR5FFC DL6SFR R+19`

## 7. Non-Standard or Incomplete Messages

These are messages that don't fit the standard QSO format. This can be due to decoding errors, non-standard callsigns, or special contest messages.

* **Format:** Varies
* **Purpose:** Varies. Can be related to contests, special events, or be the result of a partial or incorrect decode.
* **Examples:**
  * `KC3UCQ <...> -18` (Incomplete decode)
  * `CQ RU EA3BIC JN11` (Possible contest message)
  * `CQ PH25HNY` (Special event callsign)

## Example Message Sequences (QSOs)

The log file contains messages from many conversations at once. By filtering for messages between two specific stations, we can reconstruct a full contact (QSO). A standard QSO follows a predictable sequence.

### **Example 1: A complete QSO between ZW5B and W2FLY**

This sequence shows a full contact, from the initial response to the final goodbye. Note that the initial `CQ` from ZW5B and the response from ZW5B are not in the log, but can be inferred.

1. `W2FLY ZW5B -13` (W2FLY responds to ZW5B's CQ with a signal report of -13 dB)
2. `W2FLY ZW5B RR73` (W2FLY confirms ZW5B's report and says goodbye)
3. `ZW5B W2FLY 73` (ZW5B sends a final goodbye to W2FLY)

### **Example 2: A common, shorter QSO sequence**

This is a very common and minimal sequence for a complete QSO.

1. **Station A:** `CQ CALL_A GRID_A`
2. **Station B:** `CALL_A CALL_B GRID_B`
3. **Station A:** `CALL_B CALL_A -<dB>`
4. **Station B:** `CALL_A CALL_B R-<dB>`
5. **Station A:** `CALL_B CALL_A RR73`
6. **Station B:** `CALL_A CALL_B 73`

The messages are designed to be short and efficient, so operators often combine acknowledgements with the next step in the sequence.
