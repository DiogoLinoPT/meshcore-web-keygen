import urllib.request
import json
import datetime
import os

print("Fetching global nodes (this may take a few seconds, ~44MB)...")
req = urllib.request.Request('https://map.meshcore.io/api/v1/nodes', headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req) as res:
    data = json.loads(res.read().decode('utf-8'))

raw_nodes = data.get('nodes', data) if isinstance(data, dict) else data

filtered_nodes = []
for n in raw_nodes:
    lat = n.get('adv_lat') or n.get('Lat') or 0
    lon = n.get('adv_lon') or n.get('Lon') or 0
    if lat == 0 and lon == 0: continue
    
    # Brazil Bounding Box
    if -34.0 <= lat <= 6.0 and -74.0 <= lon <= -34.0:
        filtered_nodes.append(n)

today_str = datetime.datetime.now().strftime("%d-%m-%Y")

out_data = {
    "updated_at": today_str,
    "nodes": filtered_nodes
}

out_path = os.path.join(os.path.dirname(__file__), 'nodes_br.json')
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(out_data, f, ensure_ascii=False, separators=(',', ':'))

print(f"Success! Filtered down to {len(filtered_nodes)} nodes for Brazil.")
print(f"Saved to {out_path} with date {today_str}.")
