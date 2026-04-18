import math

# Haversine Distance (KM)
def calculate_distance(lat1, lon1, lat2, lon2):
    R = 6371  # Earth radius in km

    lat1 = math.radians(lat1)
    lon1 = math.radians(lon1)
    lat2 = math.radians(lat2)
    lon2 = math.radians(lon2)

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

    return R * c


# Average speed (km/h)
def calculate_avg_speed(history):
    if len(history) < 2:
        return 20  # fallback speed

    total_dist = 0
    total_time = 0

    for i in range(1, min(5, len(history))):
        p1 = history[-i-1]
        p2 = history[-i]

        dist = calculate_distance(p1["lat"], p1["lon"], p2["lat"], p2["lon"])
        time_diff = p2["timestamp"] - p1["timestamp"]

        if time_diff > 0:
            total_dist += dist
            total_time += time_diff

    if total_time == 0:
        return 20

    return total_dist / (total_time / 3600)


# ETA in seconds
def estimate_eta(distance_km, speed_kmph):
    if speed_kmph == 0:
        return 9999

    time_hours = distance_km / speed_kmph
    return round(time_hours * 3600, 2)