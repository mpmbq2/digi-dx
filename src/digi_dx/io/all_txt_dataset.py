from pathlib import Path
from typing import Any, Dict, List

from kedro.io import AbstractDataSet
from kedro.io.core import get_filepath_str, get_protocol_and_path


class AllTxtDataSet(AbstractDataSet[List[str], None]):
    """``AllTxtDataSet`` loads and saves a list of lines from a text file. The
    underlying functionality is supported by pathlib.
    """

    def __init__(self, filepath: str):
        """Creates a new instance of AllTxtDataSet.

        Args:
            filepath: The path to the text file.
        """
        self._filepath = Path(filepath)

    def _load(self) -> List[str]:
        """Loads data from the text file.

        Returns:
            A list of strings, where each string is a line from the file
            with trailing whitespace removed.
        """
        # Using get_filepath_str ensures that the protocol (e.g., 'file://') is handled.
        protocol, path = get_protocol_and_path(self._filepath)
        filepath = get_filepath_str(path, protocol)

        with open(filepath, "r") as file:
            lines = [line.rstrip() for line in file]
        return lines

    def _save(self, data: List[str]) -> None:
        """Saves data to the text file.

        Raises:
            DataSetError: When the dataset is not writable.
        """
        raise NotImplementedError(
            f"'{self.__class__.__name__}' is a read-only Kedro dataset."
        )

    def _exists(self) -> bool:
        """Checks whether the data set exists.

        Returns:
            True if the data set exists, False otherwise.
        """
        protocol, path = get_protocol_and_path(self._filepath)
        filepath = get_filepath_str(path, protocol)
        return Path(filepath).is_file()

    def _describe(self) -> Dict[str, Any]:
        """Returns a dict that describes the data set.
        """
        return dict(filepath=self._filepath)
