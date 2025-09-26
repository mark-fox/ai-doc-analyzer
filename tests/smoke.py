import requests, time

BASE="http://127.0.0.1:8000"

print("Health:", requests.get(f"{BASE}/health").json())
up = requests.post(f"{BASE}/upload-pdf", files={"file": open("test.pdf","rb")}).json()
print("Upload:", up)
time.sleep(0.5)
print("Stats:", requests.get(f"{BASE}/stats").json())
print("Search:", requests.post(f"{BASE}/search", json={"query":"quick brown","top_k":2}).json())
print("Query:", requests.post(f"{BASE}/query", json={"query":"What animal jumps over the lazy dog?","top_k":3}).json())
