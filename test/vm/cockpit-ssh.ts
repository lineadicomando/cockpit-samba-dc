// Stand-in for the "cockpit" module that runs every spawn() as root on the
// test DC over SSH, so src/lib/ can be exercised against a real DC from the
// host (see run-lib.sh). Needs the variables of .env in the environment.
import { spawn as spawnProcess } from "node:child_process";

const env = process.env;
const sshArgs = [
    "-e", "ssh",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
    // One connection for the whole run
    "-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/lab-ssh-%r@%h", "-o", "ControlPersist=60",
    `${env.DC_ADMIN_USER}@${env.DC_HOST}`,
];

function shellQuote(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
}

interface SpawnProcess extends Promise<string> {
    input(data: string): SpawnProcess;
}

export const log: string[][] = [];

function spawn(args: string[]): SpawnProcess {
    log.push(args);
    let input = "";
    let started = false;
    const p = new Promise<string>((resolve, reject) => {
        // Deferred so a chained .input() is known before the process starts
        queueMicrotask(() => {
            started = true;
            const child = spawnProcess("sshpass", [...sshArgs, `sudo -S -p '' ${args.map(shellQuote).join(" ")}`], {
                env: { ...env, SSHPASS: env.DC_ADMIN_PASSWORD },
            });
            let out = "";
            let err = "";
            child.stdout.on("data", d => { out += d; });
            child.stderr.on("data", d => { err += d; });
            child.on("close", code => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit status ${code}`))));
            child.stdin.end(`${env.DC_ADMIN_PASSWORD}\n${input}`);
        });
    }) as SpawnProcess;
    p.input = (data: string) => {
        if (started) throw new Error("input() after start");
        input = data;
        return p;
    };
    return p;
}

const cockpit = {
    spawn,
    location: { path: [] as string[], options: {}, go() { /* no-op */ } },
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
};

export default cockpit;
