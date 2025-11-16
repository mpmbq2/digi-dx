from geopy.distance import geodesic


def calc_distance(coords):
    """
    Calculate geodesic distance between two points.
    Expects a dict with keys: lat1, lon1, lat2, lon2
    """
    point1 = (coords["reference_latitude"], coords["reference_longitude"])
    point2 = (coords["latitude"], coords["longitude"])
    return geodesic(point1, point2).miles
