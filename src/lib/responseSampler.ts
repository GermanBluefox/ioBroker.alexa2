import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type AlexaRemote from './alexa-remote/alexa-remote';

/**
 * Structure of all values seen at one position of a JSON document:
 * the JSON types, for objects the properties (with the number of objects that had them) and for arrays the items.
 */
export interface Shape {
    /** JSON types seen at this position: string, number, boolean, null, object, array */
    types: string[];
    /** Number of values seen at this position */
    count: number;
    /** Some example values for primitives (max. 5) */
    examples?: (string | number | boolean)[];
    /** Properties of objects */
    properties?: Record<string, Shape>;
    /** Items of arrays */
    items?: Shape;
}

/** Collected data of one endpoint or push command */
export interface Sample {
    /** Number of responses */
    count: number;
    /** Number of error responses */
    errors: number;
    /** Last error message */
    lastError?: string;
    firstSeen: string;
    lastSeen: string;
    /** Merged structure of all responses */
    shape?: Shape;
    /** Last response (secrets redacted, arrays and strings shortened) */
    last?: unknown;
}

/** Content of the sample file */
export interface SampleFile {
    created: string;
    updated: string;
    /** Responses of the Amazon APIs by method, host and normalized path */
    responses: Record<string, Sample>;
    /** Raw push commands by command name */
    push: Record<string, Sample>;
    /** Events emitted by alexa-remote by event name */
    events: Record<string, Sample>;
}

/** Keys whose values are never written to the sample file */
const SECRET_KEYS = /token|cookie|csrf|password|secret|private|adp|authorization|refresh|macdms/i;
/** Maximum number of array items stored in the last response */
const MAX_ITEMS = 3;
/** Maximum length of strings stored in the last response */
const MAX_STRING = 300;
/** Maximum number of example values per position */
const MAX_EXAMPLES = 5;

/**
 * Returns the JSON type of a value.
 *
 * @param value value to check
 * @returns string, number, boolean, null, object or array
 */
const jsonType = (value: unknown): string => {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    return typeof value;
};

/**
 * Merges a value into the shape of its position.
 *
 * @param shape shape collected so far (or undefined)
 * @param value value to merge
 * @param key name of the property (used to redact secrets)
 * @returns the merged shape
 */
export const mergeShape = (shape: Shape | undefined, value: unknown, key = ''): Shape => {
    shape ||= { types: [], count: 0 };
    shape.count++;
    const type = jsonType(value);
    if (!shape.types.includes(type)) {
        shape.types.push(type);
        shape.types.sort();
    }
    if (type === 'object') {
        shape.properties ||= {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            shape.properties[k] = mergeShape(shape.properties[k], v, k);
        }
    } else if (type === 'array') {
        for (const item of value as unknown[]) {
            shape.items = mergeShape(shape.items, item, key);
        }
    } else if (type !== 'null' && !SECRET_KEYS.test(key)) {
        shape.examples ||= [];
        const example =
            typeof value === 'string' && value.length > 60 ? `${value.substring(0, 60)}...` : (value as string);
        if (shape.examples.length < MAX_EXAMPLES && !shape.examples.includes(example)) {
            shape.examples.push(example);
        }
    }
    return shape;
};

/**
 * Copies a value for the sample file: secrets are redacted, arrays and strings shortened.
 *
 * @param value value to copy
 * @param key name of the property
 * @returns the copy
 */
export const redact = (value: unknown, key = ''): unknown => {
    if (value === null || value === undefined) {
        return value;
    }
    if (SECRET_KEYS.test(key) && typeof value !== 'object') {
        return '<redacted>';
    }
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ITEMS).map(item => redact(item, key));
        if (value.length > MAX_ITEMS) {
            items.push(`<${value.length - MAX_ITEMS} more items>`);
        }
        return items;
    }
    if (typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            result[k] = redact(v, k);
        }
        return result;
    }
    if (typeof value === 'string') {
        // JSON inside strings (e.g. payloads of push messages) is decoded to see its structure
        if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
            try {
                return { '<json>': redact(JSON.parse(value), key) };
            } catch {
                // no JSON
            }
        }
        return value.length > MAX_STRING ? `${value.substring(0, MAX_STRING)}...` : value;
    }
    return value;
};

/**
 * Normalizes a request path to one key per endpoint: query values and ids in the path are removed.
 *
 * @param path request path (with query)
 * @returns normalized path, e.g. "/api/np/player?deviceSerialNumber&deviceType"
 */
export const normalizePath = (path: string): string => {
    const [pathname, query] = path.split('?');
    const segments = pathname.split('/').map(segment => {
        if (/^v\d{8}$/.test(segment)) {
            // API versions like v20160207
            return segment;
        }
        const isId =
            /\d{3,}/.test(segment) || // long numbers
            /^(?=.*\d)[A-Z0-9]{10,}$/.test(segment) || // serial numbers and device types (upper case)
            /[~%.]/.test(segment) || // amzn1... ids and encoded values
            /^[0-9a-f-]{20,}$/i.test(segment); // uuids
        return isId ? ':id' : segment;
    });
    const params = query
        ? query
              .split('&')
              .map(param => param.split('=')[0])
              .filter(name => name !== '_')
              .join('&')
        : '';
    return params ? `${segments.join('/')}?${params}` : segments.join('/');
};

/**
 * Records the responses of the Amazon APIs, the push commands and the events of alexa-remote and writes
 * their structure (merged over all calls) and the last value of each to a JSON file.
 * The file is used to write the TypeScript types of the undocumented Amazon responses.
 */
export class ResponseSampler {
    private readonly data: SampleFile;
    private writeTimeout: ioBroker.Timeout | undefined;

    /**
     * @param adapter adapter instance (logging and timers)
     * @param fileName file the samples are written to
     */
    constructor(
        private readonly adapter: ioBroker.Adapter,
        private readonly fileName: string,
    ) {
        const now = new Date().toISOString();
        this.data = { created: now, updated: now, responses: {}, push: {}, events: {} };
    }

    /**
     * Hooks into the HTTP calls and events of the alexa-remote instance.
     *
     * @param alexa alexa-remote instance (before init())
     */
    attach(alexa: AlexaRemote): void {
        const originalCall = alexa.httpsGetCall.bind(alexa);
        alexa.httpsGetCall = (path, callback, flags = {}): void => {
            // Calls without callback are not wrapped, as the library handles them differently
            if (typeof callback !== 'function') {
                return originalCall(path, callback, flags);
            }
            const method = flags?.method || (flags?.data ? 'POST' : 'GET');
            let host = flags?.host || alexa.baseUrl;
            let fullPath = path.replace(/[\n ]/g, '');
            if (!fullPath.startsWith('/')) {
                // full URL with own host
                const match = fullPath.replace(/^https:\/\//, '').match(/^([^/]+)(\/*.*$)/);
                if (match) {
                    host = match[1];
                    fullPath = match[2];
                }
            }
            const key = `${method} ${host}${normalizePath(fullPath)}`;
            return originalCall(
                path,
                (err, res) => {
                    // HTML pages (handleAsText) are not interesting
                    if (!flags?.handleAsText) {
                        this.record(this.data.responses, key, err, res);
                    }
                    callback(err, res);
                },
                flags,
            );
        };

        // Raw push commands
        alexa.on('command', (data: { command: string; payload: unknown }) =>
            this.record(this.data.push, data.command, null, data.payload),
        );

        // Events emitted by alexa-remote (ws-*)
        const originalEmit = alexa.emit.bind(alexa);
        alexa.emit = (event: string | symbol, ...args: any[]): boolean => {
            if (typeof event === 'string' && event !== 'command' && event !== 'cookie') {
                this.record(this.data.events, event, null, args.length > 1 ? args : args[0]);
            }
            return originalEmit(event, ...args);
        };

        this.adapter.log.info(`Amazon responses are recorded in ${this.fileName} (log level debug)`);
    }

    /**
     * Records one response.
     *
     * @param target collection to record in
     * @param key endpoint or command
     * @param err error of the call
     * @param value response
     */
    private record(target: Record<string, Sample>, key: string, err: Error | null | undefined, value: unknown): void {
        const now = new Date().toISOString();
        let sample = target[key];
        if (!sample) {
            sample = target[key] = { count: 0, errors: 0, firstSeen: now, lastSeen: now };
            this.adapter.log.debug(`New sample: ${key}`);
        }
        sample.count++;
        sample.lastSeen = now;
        if (err) {
            sample.errors++;
            sample.lastError = Array.isArray(err) ? err.join(', ') : err.message || String(err);
        } else if (value !== undefined) {
            sample.shape = mergeShape(sample.shape, value);
            sample.last = redact(value);
        }
        this.scheduleWrite();
    }

    /** Writes the file at most every 5 seconds */
    private scheduleWrite(): void {
        if (this.writeTimeout) {
            return;
        }
        this.writeTimeout = this.adapter.setTimeout(() => {
            this.writeTimeout = undefined;
            this.write();
        }, 5000);
    }

    /** Writes the collected data (also called on unload) */
    write(): void {
        if (this.writeTimeout) {
            this.adapter.clearTimeout(this.writeTimeout);
            this.writeTimeout = undefined;
        }
        this.data.updated = new Date().toISOString();
        try {
            mkdirSync(dirname(this.fileName), { recursive: true });
            writeFileSync(this.fileName, JSON.stringify(this.data, null, 2));
        } catch (err) {
            this.adapter.log.warn(`Could not write the Amazon response samples: ${(err as Error).message}`);
        }
    }
}
