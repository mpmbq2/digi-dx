# Project Overview

This project, "Digi-Dx," is a Python-based tool designed to assist with amateur radio contests that use the FT8 digital mode. The primary goal is to help users prioritize contacts based on contest-specific scoring parameters. The project is in its early stages of development.

The application is built using a combination of technologies:

*   **Frontend:** A web-based user interface is provided by [Shiny for Python](https://shiny.rstudio.com/py/).
*   **Backend:** The data processing and pipeline management are handled by the [Kedro](https://kedro.org/) framework. Data manipulation is performed using the [Polars](https://pola.rs/) library.
*   **Core Logic:** The parsing of FT8 messages is a key component of the application.

The overall architecture is designed to be modular:

1.  **User Interface (`app/app.py`):** A Shiny application that allows users to interact with the tool, such as by uploading their `ALL.TXT` log file from the WSJT-X software.
2.  **Data Handling (`app/data_handlers.py`):** This module is responsible for reading and parsing the `ALL.TXT` file, which contains the log of received and transmitted FT8 messages.
3.  **FT8 Message Parsing (`src/digi_dx/message_parsing/ft8.py`):** This is the core logic for interpreting the content of the FT8 messages. The tests in `tests/test_ft8_parser.py` provide a good overview of the expected message formats.
4.  **Data Pipelines (Kedro):** The project is structured as a Kedro project, which will be used to create and manage data pipelines for more advanced features like contact prioritization and machine learning models.

# Building and Running

## Dependencies

This project uses [Pixi](https://pixi.sh/) for environment and dependency management. To set up the environment and install all dependencies, run:

```bash
pixi install
```

## Running the Application

The main application is the Shiny UI. To run it, use the pixi task:

```bash
pixi run app
```

## Running Tests and Linting

You can run the tests and linting checks using the following pixi tasks:

```bash
pixi run test
pixi run lint
```

# Development Conventions

*   **Linting:** The project uses `ruff` for linting. The configuration can be found in the `pyproject.toml` file.
*   **Testing:** The project uses `pytest` for testing. The tests are located in the `tests/` directory.
*   **Data:** The `data/` directory is organized according to the Kedro convention, with raw data in `data/01_raw/`.
*   **Configuration:** The project uses Kedro's configuration system, with configuration files in the `conf/` directory.

# Agent Notes

## Plan before executing

Whenever the user asks you to do something, you should first propose a plan for implementation, then present that plan to the user and ask for approval. Never proceed to implementation without receiving explicit approval from the user.
