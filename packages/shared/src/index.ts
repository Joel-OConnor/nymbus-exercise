// Shared types and constants used by both the API service and the web app.
// Domain models (ISO 8583 message/transaction shapes, metric events, etc.) will live here.

export const APP_NAME = "nymbus-ops-dashboard";

export interface HealthResponse {
  status: "ok";
  service: string;
  timestamp: string;
}
