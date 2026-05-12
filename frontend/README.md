# Salamander detector — frontend

Vite + React + TypeScript UI that uploads a video to the FastAPI inference
service and overlays YOLO bounding boxes on the playing video.

## Install

```powershell
cd frontend
npm install
```

## Configure

The frontend reads the API URL from `VITE_API_URL`. Default is
`http://localhost:8000`. Copy the example file to customize:

```powershell
copy .env.example .env.local
```

## Run (development)

In one terminal, from the repo root, start the API:

```powershell
uvicorn api.main:app --reload --port 8000
```

In another terminal, start the Vite dev server:

```powershell
cd frontend
npm run dev
```

Open the printed URL (default `http://127.0.0.1:5173`).

## Production build

```powershell
npm run build
npm run preview
```
