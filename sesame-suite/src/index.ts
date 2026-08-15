import { createApp } from "./app";
import { config } from "./config";
import { startBookingSourceScheduler } from "./lib/bookingSourceScheduler";
import { startAutomationScheduler } from "./lib/automationScheduler";

const app = createApp();

app.listen(config.port, () => {
  console.log(`Sesame Suite server listening on http://localhost:${config.port}`);
  startBookingSourceScheduler();
  startAutomationScheduler();
});
