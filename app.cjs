// CommonJS entry shim for LiteSpeed / cPanel Passenger.
//
// Those hosts start the app by calling require() on the configured startup
// file. server.js is an ESM module with a top-level await (the optional
// `await import('sharp')`), and Node refuses to require() an ESM graph that
// contains top-level await (ERR_REQUIRE_ASYNC_MODULE). Loading it through a
// dynamic import() from this CommonJS file sidesteps that restriction.
import('./server.js').catch((err) => {
  console.error('Failed to start server.js:', err);
  process.exit(1);
});
