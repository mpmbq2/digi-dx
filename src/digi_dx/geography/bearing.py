import math


def calculate_bearing(lat1, lon1, lat2, lon2):
    """
    Calculate bearing between two points in degrees.
    Returns: Bearing in degrees (0-360)
    """
    # Convert to radians
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])

    dlon = lon2 - lon1

    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - (
        math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    )

    initial_bearing = math.atan2(x, y)

    # Convert to degrees and normalize to 0-360
    bearing = (math.degrees(initial_bearing) + 360) % 360

    return bearing


def calc_bearing(coords):
    """
    Calculate bearing between two points.
    Expects a dict with keys: lat1, lon1, lat2, lon2
    """
    return calculate_bearing(
        coords["Tx_latitude"],
        coords["Tx_longitude"],
        coords["Rx_latitude"],
        coords["Rx_longitude"],
    )
