require('dotenv').config();
// Polyfill for global File used by undici's WebIDL bindings.
// Node 18 doesn't provide a global File object; undici (used by @elastic/elasticsearch)
// expects it. Two options:
//  - Install `fetch-blob` (recommended for Node 18): npm install fetch-blob
//  - Upgrade Node to v20+ which includes a global File implementation.
// Try multiple fetch-blob require paths and only assign if we successfully get a constructor.
(() => {
    let FileImpl = undefined;
    try {
        // Try the file-specific export first
        const maybe = require('fetch-blob/file.js');
        FileImpl = maybe && (maybe.File || maybe.default || maybe);
    } catch (e) {
        // ignore and try the package entry
    }
    if (!FileImpl) {
        try {
            const maybe = require('fetch-blob');
            FileImpl = maybe && (maybe.File || maybe.default || maybe);
        } catch (e) {
            // still nothing
        }
    }
    // If fetch-blob didn't provide a usable File implementation, create a tiny
    // fallback using the built-in Blob (available in Node 18+) so undici's
    // WebIDL bindings can find a File constructor. This is a minimal shim —
    // if you need full spec compliance use `fetch-blob` or upgrade Node to v20+.
    if (!FileImpl) {
        try {
            if (typeof globalThis.Blob !== 'undefined') {
                FileImpl = class File extends Blob {
                    constructor(parts, name, opts = {}) {
                        super(parts, opts);
                        this.name = String(name || '');
                        this.lastModified = opts && opts.lastModified ? Number(opts.lastModified) : Date.now();
                    }
                };
            }
        } catch (e) {
            // ignore
        }
    }

    if (FileImpl && typeof globalThis.File === 'undefined') {
        globalThis.File = FileImpl;
    }
})();

// Debug: confirm whether the polyfill set global File (helps diagnose startup order)
try {
    console.error('startup debug: typeof globalThis.File =', typeof globalThis.File);
} catch (e) {
    // ignore
}
const express = require('express');
const { Client } = require('@elastic/elasticsearch');

const app = express();
const port = process.env.PORT || 3000;

const esClient = new Client({
    node: process.env.ELASTIC_URL,
    auth: process.env.ELASTIC_API_KEY
        ? { apiKey: process.env.ELASTIC_API_KEY }
        : {
            username: process.env.ELASTIC_USERNAME,
            password: process.env.ELASTIC_PASSWORD,
        },
});
/**
 * GET /aggregations - Returns some aggregations from Elasticsearch using date histogram and terms aggregations.
 * 
 * Query Parameters:
 * - index: (optional) Elasticsearch index to query; defaults to 'testing'
 * - interval: (optional) date histogram interval; defaults to '1d' (1 day)
 */
app.get('/aggregations', async (req, res) => {
    try {
        await checkElasticsearchConnection();

        const index = req.query.index || 'testing';
        const interval = req.query.interval || '1d'; // e.g. 1h, 1d
        const { from, to } = req.query; // optional ISO timestamps or ES range values

        const bodyQuery = {
            size: 0,
            aggs: {
                // Define a date histogram aggregation on the '@timestamp' field
                // to get counts of documents over time intervals.
                requests_over_time: {
                    date_histogram: {
                        field: '@timestamp',
                        calendar_interval: interval,
                        format: "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
                    }
                },
                // Define a terms aggregation on the 'url.original' field
                // to get the top 3 most common original URLs/endpoints used to make requests.     
                top_three_urls: {
                    terms: {
                        field: 'url.original',
                        size: 3
                    }
                },
                // Define a terms aggregation on the 'source.address' field
                // to get the 10 most common source addresses.
                top_ten_source_IPs: {
                    terms: {
                        field: 'source.address',
                        size: 10
                    }
                }
            }
        };

        if (from || to) {
            bodyQuery.query = { range: { '@timestamp': {} } };
            if (from) bodyQuery.query.range['@timestamp'].gte = from;
            if (to) bodyQuery.query.range['@timestamp'].lte = to;
        }

        // call search; different client versions may return the payload under `.body`
        const resp = await esClient.search({ index, body: bodyQuery });

        // support both shapes: resp.body (newer) or resp (older)
        const respBody = (resp && resp.body) ? resp.body : resp;

        // debug: log the entire response body so you can inspect mapping/errors
        console.error('debug: search response body =', JSON.stringify(respBody, null, 2));

        const timeBuckets = (respBody.aggregations && respBody.aggregations.requests_over_time && respBody.aggregations.requests_over_time.buckets) || [];
        const urlBuckets = (respBody.aggregations && respBody.aggregations.top_three_urls && respBody.aggregations.top_three_urls.buckets) || [];
        const sourceBuckets = (respBody.aggregations && respBody.aggregations.top_ten_source_IPs && respBody.aggregations.top_ten_source_IPs.buckets) || [];

        res.json({
            aggregation: 'requests_over_time',
            index,
            interval,
            requests_within_interval: timeBuckets,
            top_three_urls: urlBuckets,
            top_ten_source_IPs: sourceBuckets
        });

    } catch (error) {
        console.error('Aggregation error:', error);
        res.status(500).json({ error: String(error) });
    }
});
// Verify connection (optional)
async function checkElasticsearchConnection() {
    try {
        await esClient.ping();
        console.log('Connected to Elasticsearch');
    } catch (error) {
        console.error('Elasticsearch connection failed:', error);
    }
}


app.use(express.json()); // For parsing JSON request bodies

// Define your routes and Elasticsearch operations here
// ...

async function createIndex(indexName) {
    const { body } = await esClient.indices.exists({ index: indexName });
    if (!body) {
        await esClient.indices.create({ index: indexName });
        console.log(`Index '${indexName}' created.`);
    } else {
        console.log(`Index '${indexName}' already exists.`);
    }
}
// Example usage:
// createIndex('my_documents');

app.post('/documents', async (req, res) => {
    try {
        const { body } = await esClient.index({
            index: 'my_documents',
            body: req.body, // Assuming the request body contains the document
        });
        res.status(201).send(body);
    } catch (error) {
        console.error('Error indexing document:', error);
        res.status(500).send('Error indexing document');
    }
});
app.get('/search', async (req, res) => {
    try {
        const { query } = req.query;
        const { body } = await esClient.search({
            index: 'my_documents',
            body: {
                query: {
                    match: {
                        content: query, // Search in a 'content' field
                    },
                },
            },
        });
        res.send(body.hits.hits);
    } catch (error) {
        console.error('Error searching:', error);
        res.status(500).send('Error searching');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});