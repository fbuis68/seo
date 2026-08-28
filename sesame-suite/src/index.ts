import { createApp } from "./app";
import { config } from "./config";
import { startBookingSourceScheduler } from "./lib/bookingSourceScheduler";
import { startLockerSourceScheduler } from "./lib/lockerSourceScheduler";
import { startAutomationScheduler } from "./lib/automationScheduler";
import { VERSION } from "./lib/version";

const app = createApp();

app.listen(config.port, () => {
  console.log(`Sesame Suite server listening on http://localhost:${config.port}`);
  console.log(`Version : ${VERSION.sha} (build du ${VERSION.buildTime})`);
  startBookingSourceScheduler();
  startLockerSourceScheduler();
  startAutomationScheduler();
});
