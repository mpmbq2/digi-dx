from shiny import App, ui, render, reactive
from data_handlers import load_data, get_data_catalog
from pathlib import Path
import polars as pl

from modules import metric_dashboard, raw_analysis, contacts

CATALOG = get_data_catalog()

# Define the UI
app_ui = ui.page_fluid(
    ui.panel_title("Digi-Dx"),
    ui.layout_sidebar(
        ui.sidebar(
            ui.input_file(
                "all_file", "Choose ALL.TXT file", accept=[".txt"], multiple=False
            ),
            ui.hr(),
            ui.h4("Data Overview"),
            # Cards showing first and last timestamps
            ui.card(
                ui.card_header("First Timestamp"), ui.output_text("first_timestamp")
            ),
            ui.card(ui.card_header("Last Timestamp"), ui.output_text("last_timestamp")),
            ui.hr(),
            # Date range selector
            ui.input_date_range(
                "date_range", "Filter by Date Range", start="2025-01-01", end=None
            ),
            width=300,
        ),
        # Main content area with tabs
        ui.navset_tab(
            ui.nav_panel("All Data", raw_analysis.all_data_ui("raw")),
            ui.nav_panel(
                "Summary Statistics",
                raw_analysis.summary_stats_ui("raw"),
            ),
            ui.nav_panel(
                "Frequency Analysis",
                raw_analysis.frequency_ui("raw"),
            ),
            ui.nav_panel(
                "Contacts Table",
                contacts.contacts_ui("contacts"),
            ),
            ui.nav_panel(
                "Caller Table",
                ui.h3("Caller Table"),
                metric_dashboard.dashboard_ui("callers"),
            ),
            ui.nav_panel(
                "Hunter Table",
                ui.h3("Hunter Table"),
                metric_dashboard.dashboard_ui("hunters"),
            ),
            id="main_tabs",
        ),
    ),
)


# Define the server logic
def server(input, output, session):
    @reactive.calc
    def get_data():
        """Reactive calculation to load data from uploaded file or default path"""
        file_info = input.all_file()

        if file_info is not None and len(file_info) > 0:
            # Use uploaded file
            file_path = file_info[0]["datapath"]
        else:
            # Use default file
            file_path = Path(__file__).parent / ".." / "data" / "01_raw" / "ALL.TXT"

        return load_data(str(file_path))

    @reactive.calc
    def filtered_data():
        """Filter data based on selected date range"""
        data = get_data()

        # Get the date range inputs
        date_range = input.date_range()

        if date_range is None or date_range[0] is None or date_range[1] is None:
            # No filtering if dates aren't selected
            return data

        start_date = date_range[0]
        end_date = date_range[1]

        # Filter data by timestamp
        filtered = data.filter(
            (pl.col("datetime").dt.date() >= start_date)
            & (pl.col("datetime").dt.date() <= end_date)
        )

        return filtered

    @reactive.calc
    def filtered_contacts_data():
        """Filter contacts data based on selected date range"""
        date_range = input.date_range()

        if date_range is None or date_range[0] is None or date_range[1] is None:
            data = CATALOG.load("table#Contacts").collect()
        else:
            start_date = date_range[0]
            end_date = date_range[1]

            data = (
                CATALOG.load("table#Contacts")
                .filter(
                    (pl.col("timestamp").dt.date() >= start_date),
                    (pl.col("timestamp").dt.date() <= end_date)
                )
                .collect()
            )

        if "priority_score_prob" in data.columns:
            data = data.sort("priority_score_prob")
        elif "priority_score" in data.columns:
            data = data.sort("priority_score")
        
        return data

    @reactive.calc
    def filtered_caller_data():
        """Filter caller data based on selected date range"""
        date_range = input.date_range()

        if date_range is None or date_range[0] is None or date_range[1] is None:
            # Load all data if dates aren't selected
            data = CATALOG.load("table#Callers").collect()
        else:
            start_date = date_range[0]
            end_date = date_range[1]

            data = (
                CATALOG.load("table#Callers")
                .filter(
                    (pl.col("timestamp").dt.date() >= start_date),
                    (pl.col("timestamp").dt.date() <= end_date)
                )
                .collect()
            )
            
        if "priority_score_prob" in data.columns:
            data = data.sort("priority_score_prob")
        elif "priority_score" in data.columns:
            data = data.sort("priority_score")

        return data

    @reactive.calc
    def filtered_hunter_data():
        """Filter hunter data based on selected date range"""
        date_range = input.date_range()

        if date_range is None or date_range[0] is None or date_range[1] is None:
            # Load all data if dates aren't selected
            data = CATALOG.load("table#Hunters").collect()
        else:
            start_date = date_range[0]
            end_date = date_range[1]

            data = (
                CATALOG.load("table#Hunters")
                .filter(
                    (pl.col("timestamp").dt.date() >= start_date),
                    (pl.col("timestamp").dt.date() <= end_date)
                )
                .collect()
            )

        if "priority_score" in data.columns:
            data = data.sort("priority_score")
            
        return data

    @render.text
    def first_timestamp():
        """Display the first (oldest) timestamp in the dataset"""
        data = get_data()
        if len(data) > 0:
            first_ts = data["timestamp"].min()
            return str(first_ts)
        return "No data available"

    @render.text
    def last_timestamp():
        """Display the last (newest) timestamp in the dataset"""
        data = get_data()
        if len(data) > 0:
            last_ts = data["timestamp"].max()
            return str(last_ts)
        return "No data available"

    # Call module servers
    raw_analysis.analysis_server("raw", filtered_data)
    contacts.contacts_server("contacts", filtered_contacts_data)
    metric_dashboard.dashboard_server("callers", filtered_caller_data)
    metric_dashboard.dashboard_server("hunters", filtered_hunter_data)


# Create the Shiny app
app = App(app_ui, server)
