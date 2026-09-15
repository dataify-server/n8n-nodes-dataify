const { spawnSync } = require('node:child_process');

const knownHighFindings = {
	'@n8n/utils': {
		via: ['nanoid'],
	},
	'n8n-workflow': {
		via: ['@n8n/utils'],
	},
	nanoid: {
		advisories: [1138811, 1139427, 1153189],
	},
};

const npmCli = process.env.npm_execpath;
const command = npmCli ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const args = npmCli
	? [npmCli, 'audit', '--package-lock-only', '--omit=dev', '--json']
	: ['audit', '--package-lock-only', '--omit=dev', '--json'];
const audit = spawnSync(npmCli ? process.execPath : command, args, {
	encoding: 'utf8',
	maxBuffer: 10 * 1024 * 1024,
});

if (audit.error) {
	console.error(`Unable to run npm audit: ${audit.error.message}`);
	process.exit(1);
}

let report;
try {
	report = JSON.parse(audit.stdout);
} catch {
	console.error(audit.stderr || audit.stdout || 'npm audit returned invalid JSON');
	process.exit(1);
}

const blockingFindings = Object.entries(report.vulnerabilities ?? {}).filter(([, finding]) =>
	['high', 'critical'].includes(finding.severity),
);
const unexpectedFindings = blockingFindings.filter(([name, finding]) => {
	const known = knownHighFindings[name];
	if (!known || finding.severity !== 'high') return true;
	if (known.via) return JSON.stringify(finding.via) !== JSON.stringify(known.via);

	const advisoryIds = finding.via
		.filter((entry) => typeof entry === 'object' && entry !== null)
		.map((entry) => entry.source)
		.sort((left, right) => left - right);
	return JSON.stringify(advisoryIds) !== JSON.stringify(known.advisories);
});

if (unexpectedFindings.length > 0) {
	console.error('Unexpected high or critical production dependency findings:');
	for (const [name, finding] of unexpectedFindings) {
		console.error(`- ${name}: ${finding.severity}`);
	}
	process.exit(1);
}

if (blockingFindings.length > 0) {
	console.warn(
		'Allowed host-owned n8n peer findings: n8n-workflow -> @n8n/utils -> nanoid (GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w).',
	);
}

console.log('Production dependency audit passed: no unexpected high or critical findings.');
