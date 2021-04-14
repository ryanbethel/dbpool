# Serverless Queue for Relational Database

Dpool is a pooling queue for using relational databases directly from serverless applications. The pool function uses a DynamoDB table as a queue to request and limit connections to the relational database. The pool adds a small amount of latency from the minimum write to and read from the DynamoDB table. If all connections are full the request will poll periodically and connect when available.

## What's it good for

It is intended to ease the on-ramp to serverless by allowing applications to use a traditionally hosted small instance of a relational database. For instance a free tier Heroku database limited to 20 connections. For these small applications and prototypes it is likely that the required DynamoDB usage will be low and possibly stay within the free tier.

## What's it not good for

It is probably not the best for a large, high traffic application. At some point the additional cost of DynamoDB use for the pool queue will exceed the cost of other options (i.e. RDS-proxy, pgbouncer, etc.). Dpool can be put in bypass mode to disable the pool function.

## Caution! (Big DynamoDB Bill)

The combination of the `timeout`, `maxRetries`, and `minWaitQueueMs` could result in many transactions to dynamoDB generating larger than expected bills. If the queue is full it will poll every `minWaitQueueMs` resulting in a read to the table. It will retry for `maxRetries` or until `timeout` expires. This could result in `maxRetries` plus 2 reads to dynamoDB for every operation.

## Why

For many people trying serverless for the first time the database is the hardest part of the system. DynamoDB works very well with serverless applications and it has an on-demand pricing model that makes it free to start with and easy to scale up. But DynamoDB also has a steep learning curve. Many people want to stick with relational databases they are comfortable with, but this means hosting the database somewhere and usually paying fixed costs. There is also an impedance mismatch with how most relational databases scale to spikes in traffic vs how serverless applications do. You could have a small serverless application and a small database instance (i.e. with a limit of 20 connections) that is correctly sized to your general traffic. But if you have a spike of 100 requests in a minute your serverless endpoint will request 100 connections to the database causing most to fail.

There are solutions like pgbouncer or RDS-proxy to handle this. Both of these run on a server with fixed cost. This basically shifts the problem. Now you have a database and a proxy server running all the time with fixed costs and scaling to worry about. There are serverless databases like Aurora or Fauna that try to solve this problem by managing scaling and connections for the user. But these are usually more expensive.

## Arguments

There are three arguments to the function:

1. **Operation**: A function that returns a promise that resolves to the result of the database operation. This function should open a connection to the database and then make one or more calls to the database resolving when they are complete. It should not close the connection.
2. **Cleanup**: A function that returns a promise that closes the connection to the database and does any other required cleanup operation. This promise resolves when the cleanup is complete.
3. **Config**: An object with configuration properties. These properties can be seen in the example below.

## Getting Started

Dpool is built for use with the [Architect](arc.codes) ([arc.codes](arc.codes)) framework. It could easily be adapted for use in other AWS applications. To use it:

1. `npm install dpool`
2. Add a dynamoDB table to the architect manifest file `app.arc`

```
@tables
pooltable
  pk *String
  sk **String
  ttl TTL
```

3. Use in any lambda function as follows:

```javascript
let { PrismaClient } = require("@prisma/client");
let prisma = new PrismaClient();
let { dpool } = require("dpool");
let poolConfig = {
    timeout: 10000, //maximum time for operation (if lock is not removed from queue it is ignored after this period)
    poolName: "pool1",
    poolSize: 20,
    bypass: false, //bypass and run without pool
    minWaitQueueMs: 100, //delay before retrying if queue is full
    waitVarianceMs: 20, //random variation in retry
    maxRetries: 50, //maximum number of retries before throwing
    queryLimit: 1000, //limit on queue query to avoid large queries
    poolTable: "pooltable", //matching DynamoDB table in app.arc manifest
};

exports.handler = async function endpoint(req) {
    let output;
    try {
        let dbOperation = async () => {
            await prisma.$connect();
            let res = await prisma.post.findMany({ where: { published: false } });
            return res;
        };
        let cleanup = async () => await prisma.$disconnect();

        let result = await dpool(dbOperation, cleanup, poolConfig);

        output = JSON.stringify(result);
    } catch (e) {
        console.log(e);
        return { statusCode: 400 };
    }
    return {
        statusCode: 200,
        headers: {
            "cache-control": "no-cache, no-store, must-revalidate, max-age=0, s-maxage=0",
            "content-type": "application/json; charset=utf8",
        },
        body: output,
    };
};
```
