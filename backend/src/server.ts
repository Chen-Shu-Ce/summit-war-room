import app from "./app";

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`EPCOS V4 API running on http://localhost:${PORT}`);
  console.log(`  POST /api/v1/auth/login  — get JWT token`);
  console.log(`  GET  /api/v1/site-requests`);
  console.log(`  GET  /api/v1/purchase-requests`);
  console.log(`  GET  /api/v1/purchase-orders`);
  console.log(`  GET  /api/v1/inspections`);
  console.log(`  GET  /api/v1/payment-claims`);
});
