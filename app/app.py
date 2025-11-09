from pathlib import Path

# from shiny import render, ui
from shiny.express import input, render, ui

from data_handlers import load_data


with ui.sidebar(bg="#f8f8f8") as sidebar:
    ui.input_file("all_file", "Select your ALL.TXT file")


ui.panel_title("Hello Shiny!")
ui.input_slider("n", "N", 0, 100, 20)


@render.text
def txt():
    return f"n*2 is {input.n() * 2}"


@render.data_frame
def all_txt():
    # path = Path(input.all_file)
    # return load_data(path)
    return render.DataGrid(load_data())
