/** @type {import("pm2").StartOptions} */
const api = {
    name: "pipipi",
    cwd: __dirname,
    script: "npm",
    args: "run start:api",
    interpreter: "none",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    restart_delay: 5_000,
    max_restarts: 5,
    kill_timeout: 270_000,
    time: true,
    env: {
        NODE_ENV: "production",
        PORT: "4300",
        ASYNC_PROCESS_RUNS_ENABLED: "false",
    },
};

module.exports = { apps: [api] };
