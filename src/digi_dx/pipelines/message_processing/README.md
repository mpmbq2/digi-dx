# Message Processing Pipeline

This pipeline processes radio messages from the ALL.TXT file and separates them into Rx (received) and Tx (transmitted) messages using Kedro's namespaced pipelines feature.

## Overview

The pipeline is designed to:
1. Load raw message data from a file
2. Parse the messages into structured columns
3. Filter messages by direction (Rx or Tx)
4. Output separate datasets for received and transmitted messages

## Architecture

The pipeline uses **Kedro namespacing** to share common processing logic while producing separate outputs:

```
Raw Data (ALL.TXT)
       |
       v
Load Raw Messages (shared)
       |
       v
Parse Messages (shared)
       |
       +---> Filter Rx --> rx_messages.parquet
       |
       +---> Filter Tx --> tx_messages.parquet
```

## Namespaces

### `rx` namespace
Processes **received messages** (direction = "Rx")
- Input: `data/01_raw/ALL.TXT`
- Output: `data/02_intermediate/rx_messages.parquet`
- Parameter: `rx.direction = "Rx"`

### `tx` namespace
Processes **transmitted messages** (direction = "Tx")
- Input: `data/01_raw/ALL.TXT`
- Output: `data/02_intermediate/tx_messages.parquet`
- Parameter: `tx.direction = "Tx"`

## Running the Pipeline

### Run both pipelines (default)
```bash
kedro run
```

### Run only Rx pipeline
```bash
kedro run --pipeline=rx
```

### Run only Tx pipeline
```bash
kedro run --pipeline=tx
```

## Nodes

### `load_raw_messages`
Loads the raw message file into a DataFrame with a single "raw" column.

### `parse_messages`
Parses the whitespace-separated message data into structured columns:
- timestamp
- datetime
- frequency
- direction (Rx/Tx)
- protocol
- signal_report
- time_offset
- freq_offset
- target
- sender
- message

### `filter_by_direction`
Filters messages based on the direction parameter (Rx or Tx).

## Configuration

### Catalog (`conf/base/catalog.yml`)
Defines the datasets for both namespaces, including:
- Shared input file (`raw_messages_file`)
- Namespace-specific intermediate datasets
- Output files for filtered messages

### Parameters (`conf/base/parameters.yml`)
Defines the direction parameter for each namespace:
```yaml
rx:
  direction: "Rx"

tx:
  direction: "Tx"
```

## Benefits of Namespacing

1. **Code Reuse**: The same parsing logic is used for both Rx and Tx messages
2. **Maintainability**: Changes to parsing logic automatically apply to both pipelines
3. **Clarity**: Clear separation between received and transmitted message processing
4. **Flexibility**: Can run pipelines independently or together
5. **Extensibility**: Easy to add new namespaces (e.g., for different protocols)
