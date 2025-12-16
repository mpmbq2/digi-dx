FT8_GRIDSQUARE_LENGTH = 4

def maidenhead_to_lat(grid_square: str) -> float:
    """
    Convert 4-character Maidenhead grid square to latitude.

    Args:
        grid_square (str): 4-character grid square (e.g., 'FN31')

    Returns:
        float: Latitude in decimal degrees (center of square)
    """
    if not isinstance(grid_square, str) or len(grid_square) != FT8_GRIDSQUARE_LENGTH:
        return None

    grid_square = grid_square.upper()

    # Extract latitude components
    lat_field = grid_square[1]  # Second letter (A-R)
    lat_square = grid_square[3]  # Fourth digit (0-9)

    # Validate
    if not ('A' <= lat_field <= 'R' and lat_square.isdigit()):
        return None

    # Convert to numbers
    lat_field_num = ord(lat_field) - ord('A')
    lat_square_num = int(lat_square)

    # Calculate latitude (center of square)
    latitude = -90 + (lat_field_num * 10) + lat_square_num + 0.5

    return latitude


def maidenhead_to_lon(grid_square: str) -> float:
    """
    Convert 4-character Maidenhead grid square to longitude.

    Args:
        grid_square (str): 4-character grid square (e.g., 'FN31')

    Returns:
        float: Longitude in decimal degrees (center of square)
    """
    if not isinstance(grid_square, str) or len(grid_square) != FT8_GRIDSQUARE_LENGTH:
        return None

    grid_square = grid_square.upper()

    # Extract longitude components
    lon_field = grid_square[0]  # First letter (A-R)
    lon_square = grid_square[2]  # Third digit (0-9)

    # Validate
    if not ('A' <= lon_field <= 'R' and lon_square.isdigit()):
        return None

    # Convert to numbers
    lon_field_num = ord(lon_field) - ord('A')
    lon_square_num = int(lon_square)

    # Calculate longitude (center of square)
    longitude = -180 + (lon_field_num * 20) + (lon_square_num * 2) + 1.0

    return longitude
