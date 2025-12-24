from shiny import module, ui, render, reactive
import polars as pl

@module.ui
def dashboard_ui():
    return ui.layout_columns(
        ui.card(
            ui.card_header("Potential Contacts"),
            ui.output_text("count"),
        ),
        ui.card(
            ui.card_header("Total Miles"),
            ui.output_text("total_miles"),
        ),
        ui.card(
            ui.card_header("Average Miles"),
            ui.output_text("avg_miles"),
        ),
        col_widths=[4, 4, 4]
    ), ui.output_data_frame("table")

@module.server
def dashboard_server(input, output, session, df: reactive.Value[pl.DataFrame], metric_col: str = "distance_miles"):
    
    @render.text
    def count():
        data = df()
        if len(data) > 0:
            return str(len(data))
        return "0"

    @render.text
    def total_miles():
        data = df()
        if len(data) > 0:
            total = data[metric_col].sum()
            return f"{total:,.0f}"
        return "0"

    @render.text
    def avg_miles():
        data = df()
        if len(data) > 0:
            avg = data[metric_col].mean()
            return f"{avg:.1f}"
        return "0.0"

    @render.data_frame
    def table():
        return render.DataGrid(df())
