#!/usr/bin/env node
/**
 * scoova-upload-sourcemaps — upload a directory of .map files to Scoova Monitor
 * so the dashboard can show file:line stack frames instead of minified gibberish.
 *
 * Install: drop into your build pipeline:
 *   node ./node_modules/@scoova/monitor-web/scripts/scoova-upload-sourcemaps.js \
 *     --api-key sm_xxx \
 *     --version 1.4.0 \
 *     --build 42 \
 *     --dir ./dist/assets
 *
 * Or via npx:
 *   npx scoova-upload-sourcemaps --api-key sm_xxx --version 1.4.0 ...
 *
 * Use this from your CI / Vite / Webpack post-build step. Every .map file in
 * the directory is uploaded under the same (project, version, build_number).
 *
 * No external dependencies — uses Node's built-in fs / https.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');

const args = parseArgs(process.argv.slice(2));

if (!args['api-key'] || !args.version || !args.dir) {
    usage();
    process.exit(1);
}

const endpoint = args.endpoint || 'https://monitor.scoo-va.info';
const buildNumber = String(args.build || '');

main().catch(err => {
    console.error('FAILED:', err.message || err);
    process.exit(2);
});

async function main() {
    const dir = path.resolve(args.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`directory not found: ${dir}`);
    }
    const files = walk(dir).filter(f => f.endsWith('.map'));
    if (files.length === 0) {
        console.error(`no .map files found in ${dir}`);
        return;
    }
    console.log(`Found ${files.length} source map(s) in ${dir}`);
    console.log(`Uploading to ${endpoint} for v${args.version} build ${buildNumber || '(none)'}`);

    let ok = 0;
    let failed = 0;
    for (const file of files) {
        const rel = path.relative(dir, file);
        try {
            await uploadOne(file, rel);
            console.log(`  ✓ ${rel}`);
            ok++;
        } catch (e) {
            console.error(`  ✗ ${rel}: ${e.message}`);
            failed++;
        }
    }
    console.log(`\nDone: ${ok} uploaded, ${failed} failed.`);
    if (failed > 0) process.exit(3);
}

function uploadOne(filePath, name) {
    return new Promise((resolve, reject) => {
        const data = fs.readFileSync(filePath);
        const target = url.parse(endpoint + '/v1/upload/mapping');
        const isHttps = target.protocol === 'https:';
        const lib = isHttps ? https : http;

        // Multipart form-data — minimal hand-rolled implementation, no libraries.
        const boundary = '----scoova' + Math.random().toString(36).slice(2);
        const parts = [];
        const field = (name, value) => {
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            ));
        };
        // Server expects camelCase form field names
        field('appVersion', args.version);
        field('buildNumber', buildNumber);
        field('platform', 'web');
        field('mappingType', 'sourcemap');
        // file part
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="mapping"; filename="${name}"\r\n` +
            `Content-Type: application/json\r\n\r\n`,
        ));
        parts.push(data);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
        const body = Buffer.concat(parts);

        const req = lib.request({
            hostname: target.hostname,
            port: target.port,
            path: target.path,
            method: 'POST',
            headers: {
                'X-API-Key': args['api-key'],
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.length,
            },
            timeout: 60_000,
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const status = res.statusCode || 0;
                const text = Buffer.concat(chunks).toString('utf8');
                if (status >= 200 && status < 300) return resolve();
                reject(new Error(`HTTP ${status}: ${text.slice(0, 200)}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('upload timed out')));
        req.write(body);
        req.end();
    });
}

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const k = a.slice(2);
            const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
            out[k] = v;
        }
    }
    return out;
}

function usage() {
    console.error(`scoova-upload-sourcemaps — upload .map files to Scoova Monitor

Usage:
  scoova-upload-sourcemaps --api-key <KEY> --version <V> --build <BUILD> --dir <DIR> [--endpoint <URL>]

Options:
  --api-key   (required) Scoova Monitor API key for the Web platform
  --version   (required) App version string, e.g. "1.4.0"
  --build     Build number / commit SHA (optional but recommended)
  --dir       (required) Directory containing .map files (recursively scanned)
  --endpoint  Override the Scoova endpoint (default: https://monitor.scoo-va.info)

Examples:
  # Vite build
  npm run build && scoova-upload-sourcemaps \\
    --api-key $SCOOVA_API_KEY --version 1.4.0 --build $GIT_SHA --dir ./dist/assets

  # Webpack
  scoova-upload-sourcemaps --api-key $SCOOVA_API_KEY --version 1.4.0 --dir ./build/static/js
`);
}
