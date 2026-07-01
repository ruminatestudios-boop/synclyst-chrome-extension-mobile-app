export const PLAN_LIMITS = {
    // Dev/test convenience: allow a couple more scans on FREE.
    "FREE": process.env.NODE_ENV === "production" ? 3 : 10,
    "Starter": 100,
    "Growth": 500,
    "Power": 1000,
};
