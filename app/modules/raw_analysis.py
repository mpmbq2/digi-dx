from shiny import module, ui, render, reactive
import polars as pl

@module.ui
def all_data_ui():
    return ui.output_data_frame("grid")

@module.ui
def summary_stats_ui():
    return ui.TagList(
        ui.h3("Summary Statistics"),
        ui.output_text("stats")
    )

@module.ui
def frequency_ui():
    return ui.TagList(
        ui.h3("Frequency Analysis"),
        ui.output_data_frame("freq_table")
    )

@module.server
def analysis_server(input, output, session, df: reactive.Value[pl.DataFrame]):
    
    @render.data_frame
    def grid():
        """Display the filtered data grid"""
        return render.DataGrid(df())

    @render.text
    def stats():
        """Display summary statistics for the filtered data"""
        data = df()
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
    def freq_table():
        """Display frequency analysis by protocol"""
        data = df()
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
