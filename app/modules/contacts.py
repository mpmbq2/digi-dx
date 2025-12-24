from shiny import module, ui, render, reactive
import polars as pl

@module.ui
def contacts_ui():
    return ui.TagList(
        ui.h3("Contacts Table"),
        ui.output_data_frame("table")
    )

@module.server
def contacts_server(input, output, session, df: reactive.Value[pl.DataFrame]):
    @render.data_frame
    def table():
        return render.DataGrid(df())
