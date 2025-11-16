from pathlib import PurePosixPath
from typing import Any

import fsspec
from kedro.io import AbstractDataset
from kedro.io.core import get_filepath_str, get_protocol_and_path


class AllTxtDataset(AbstractDataset[list[str], None]):
    """``AllTxtDataSet`` loads a list of lines from a text file."""

    def __init__(self, filepath: str):
        """Creates a new instance of AllTxtDataSet.

        Args:
            filepath: The path to the text file.
        """
        protocol, path = get_protocol_and_path(filepath)
        self._protocol = protocol
        self._filepath = PurePosixPath(path)
        self._fs = fsspec.filesystem(self._protocol)

    def _load(self) -> list[str]:
        """Loads data from the text file.

        Returns:
            A list of strings, where each string is a line from the file
            with trailing whitespace removed.
        """
        load_path = get_filepath_str(self._filepath, self._protocol)
        with self._fs.open(load_path, "r") as f:
            lines = [line.rstrip() for line in f]
        return lines

    def _save(self, data: list[str]) -> None:
        """Saves data to the text file.

        Raises:
            NotImplementedError: When the dataset is not writable.
        """
        raise NotImplementedError(
            f"'{self.__class__.__name__}' is a read-only Kedro dataset."
        )

    def _exists(self) -> bool:
        """Checks whether the data set exists.

        Returns:
            True if the data set exists, False otherwise.
        """
        return self._fs.exists(get_filepath_str(self._filepath, self._protocol))

    def _describe(self) -> dict[str, Any]:
        """Returns a dict that describes the data set."""
        return dict(filepath=str(self._filepath), protocol=self._protocol)
