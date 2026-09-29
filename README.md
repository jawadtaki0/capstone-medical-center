# Medical Center Capstone

A medical-center website and operations-system capstone. The intended product combines public information, clinic-session booking, a patient portal, and staff clinic/laboratory workflows. It is a prototype, not a system deployed at or affiliated with a medical center. Development uses synthetic data only.

## Current status

This repository contains a responsive **Home-page visual prototype** and a minimal Express health endpoint, not the completed product. The Home page uses fictional sample content; its booking, login, laboratory, and service buttons show an explanatory preview dialog. Patient login, booking, queues, lab results, billing, and WhatsApp delivery are **not implemented yet**. The former frontend health display has been replaced; the API health endpoint remains unchanged.

The licensed hero photograph is kept outside this public repository. Current production builds show a graceful fallback; deployment will supply the image separately.

## Technology

- React and Vite frontend (`apps/web`)
- Node.js and Express API (`apps/api`)
- MongoDB integration prepared but not required to run the foundation

## Run locally

Install Node.js 22 or newer. From the repository root, run:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend proxies `/api` requests to the API at `http://localhost:4000`. The API health endpoint is `http://localhost:4000/api/health`.

MongoDB is optional at this stage. To configure a local database later, copy `apps/api/.env.example` to `apps/api/.env` and set `MONGODB_URI`. Never commit `.env` or real patient data.

## Checks

```powershell
npm test
npm run build
```

## Intended scope

The planned system includes public pages, configurable full-doctor-session booking with shared capacity across online and receptionist requests, an FCFS check-in queue, staff-approved extra walk-ins, patient access to approved lab-result PDFs, and separate clinic/lab reception workflows. Messaging will use mock/synthetic delivery during development; live WhatsApp integration requires authorization and is not present. No online lab booking, online payment, pharmacy, insurance, AI chatbot, or electronic doctor notes are planned for the first version.
