from shiny import App, ui, render, reactive
from data_handlers import load_data, get_data_catalog
from pathlib import Path
import polars as pl

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
                "date_range", "Filter by Date Range", start=None, end=None
            ),
            width=300,
        ),
        # Main content area with tabs
        ui.navset_tab(
            ui.nav_panel("All Data", ui.output_data_frame("data_grid")),
            ui.nav_panel(
                "Summary Statistics",
                ui.h3("Summary Statistics"),
                ui.output_text("summary_stats"),
            ),
            ui.nav_panel(
                "Frequency Analysis",
                ui.h3("Frequency Analysis"),
                ui.output_data_frame("frequency_table"),
            ),
            ui.nav_panel(
                "Contacts Table",
                ui.h3("Contacts Table"),
                ui.output_data_frame("contacts_table"),
            ),
            ui.nav_panel(
                "Caller Table",
                ui.h3("Caller Table"),
                ui.layout_columns(
                    ui.card(
                        ui.card_header("Potential Contacts"),
                        ui.output_text("caller_count"),
                    ),
                    ui.card(
                        ui.card_header("Total Miles"),
                        ui.output_text("caller_total_miles"),
                    ),
                    ui.card(
                        ui.card_header("Average Miles"),
                        ui.output_text("caller_avg_miles"),
                    ),
                ),
                ui.output_data_frame("caller_table"),
            ),
            ui.nav_panel(
                "Hunter Table",
                ui.h3("Hunter Table"),
                ui.layout_columns(
                    ui.card(
                        ui.card_header("Potential Contacts"),
                        ui.output_text("hunter_count"),
                    ),
                    ui.card(
                        ui.card_header("Total Miles"),
                        ui.output_text("hunter_total_miles"),
                    ),
                    ui.card(
                        ui.card_header("Average Miles"),
                        ui.output_text("hunter_avg_miles"),
                    ),
                ),
                ui.output_data_frame("hunter_table"),
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

        return load_data(file_path)

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
    def filtered_caller_data():
        """Filter caller data based on selected date range"""
        date_range = input.date_range()

        if date_range is None or date_range[0] is None or date_range[1] is None:
            # Load all data if dates aren't selected
            return CATALOG.load("table#Callers").collect()

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

        return data

    @reactive.calc
    def filtered_hunter_data():
        """Filter hunter data based on selected date range"""
        date_range = input.date_range()

        if date_range is None or date_range[0] is None or date_range[1] is None:
            # Load all data if dates aren't selected
            return CATALOG.load("table#Hunters").collect()

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

        return data

    @render.text
    def first_timestamp():
        """Display the first (oldest) timestamp in the dataset"""
        data = get_data()
        if len(data) > 0:
            first_ts = data["timestamp"].min()
            return first_ts
        return "No data available"

    @render.text
    def last_timestamp():
        """Display the last (newest) timestamp in the dataset"""
        data = get_data()
        if len(data) > 0:
            last_ts = data["timestamp"].max()
            return last_ts
        return "No data available"

    @render.data_frame
    def data_grid():
        """Display the filtered data grid"""
        return render.DataGrid(filtered_data())

    @render.text
    def summary_stats():
        """Display summary statistics for the filtered data"""
        data = filtered_data()
        if len(data) > 0:
            total_records = len(data)
            unique_senders = data["sender"].n_unique()
            unique_targets = data["target"].n_unique()
            unique_protocols = data["protocol"].n_unique()

            return f"""
Total Records: {total_records}
Unique Senders: {unique_senders}
Unique Targets: {unique_targets}
Unique Protocols: {unique_protocols}
            """
        return "No data available"

    @render.data_frame
    def frequency_table():
        """Display frequency analysis by protocol"""
        data = filtered_data()
        if len(data) > 0:
            freq_analysis = (
                data.group_by("protocol")
                .agg(
                    [
                        pl.count().alias("count"),
                        pl.col("sender").n_unique().alias("unique_senders"),
                        pl.col("target").n_unique().alias("unique_targets"),
                    ]
                )
                .sort("count", descending=True)
            )
            return render.DataGrid(freq_analysis)
        return render.DataGrid(pl.DataFrame())

    @render.data_frame
    def contacts_table():

        date_range = input.date_range()

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

        return render.DataGrid(data)

    @render.text
    def caller_count():
        """Display the number of potential caller contacts"""
        data = filtered_caller_data()
        if len(data) > 0:
            return str(len(data))
        return "0"

    @render.text
    def caller_total_miles():
        """Display the total miles available from caller contacts"""
        data = filtered_caller_data()
        if len(data) > 0:
            total = data["distance_miles"].sum()
            return f"{total:,.0f}"
        return "0"

    @render.text
    def caller_avg_miles():
        """Display the average miles for caller contacts"""
        data = filtered_caller_data()
        if len(data) > 0:
            avg = data["distance_miles"].mean()
            return f"{avg:.1f}"
        return "0.0"

    @render.data_frame
    def caller_table():
        """Display the caller data grid"""
        return render.DataGrid(filtered_caller_data())

    @render.text
    def hunter_count():
        """Display the number of potential hunter contacts"""
        data = filtered_hunter_data()
        if len(data) > 0:
            return str(len(data))
        return "0"

    @render.text
    def hunter_total_miles():
        """Display the total miles available from hunter contacts"""
        data = filtered_hunter_data()
        if len(data) > 0:
            total = data["distance_miles"].sum()
            return f"{total:,.0f}"
        return "0"

    @render.text
    def hunter_avg_miles():
        """Display the average miles for hunter contacts"""
        data = filtered_hunter_data()
        if len(data) > 0:
            avg = data["distance_miles"].mean()
            return f"{avg:.1f}"
        return "0.0"

    @render.data_frame
    def hunter_table():
        """Display the hunter data grid"""
        return render.DataGrid(filtered_hunter_data())



# Create the Shiny app
app = App(app_ui, server)
