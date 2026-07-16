# OpenCode Mobile

An OpenCode mobile client built with Expo and React Native. It connects to an
OpenCode relay through QR pairing or a manual relay URL and credential.

## Prerequisites

- Node.js
- Expo tooling

## Run locally

```sh
npm install
npm run ios
npm run android
npm run web
```

## Connect to a relay

The app has no hardcoded relay default. Use the host setup screen to scan a QR
pairing code, or enter your own relay HTTPS URL and credential.

## Build your own app

Before building, update `app.json` with your own app `name`, `slug`, and
`ios.bundleIdentifier` values.
