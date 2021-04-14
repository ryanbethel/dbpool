let arc = require("@architect/functions");
let { ulid } = require("ulid");

async function dpool(
    operation,
    cleanup,
    {
        timeout = 10000, //maximum time for operation (if lock is not removed from queue it is ignored after this period)
        poolName = "pool1",
        poolSize = 20,
        bypass = false, //bypass and run without pool
        minWaitQueueMs = 100, //delay before retrying if queue is full
        waitVarianceMs = 20, //random variation in retry
        maxRetries = 50, //maximum number of retries before throwing
        queryLimit = 1000, //limit on queue query to avoid large queries
        poolTable,
    }
) {
    if (bypass) {
        let result = await operation();
        await cleanup();
        return result;
    }
    let dynamo = await arc.tables();
    let nowMs = Date.now();
    let lockId = ulid(nowMs);
    let nowSec = Math.round(nowMs / 1000);
    let ttl = nowSec + 60 * 60;

    // Grab a spot in line in the Pool
    await dynamo[poolTable].put({ pk: poolName, sk: lockId, exp: nowMs + timeout, ttl });

    //if db operations don't complete in max time window attempt to disconnect and remove lock from pool
    let didTimeout = false;
    let maxTimeout = timeoutWithCancel(timeout, "Max Time Expired");
    maxTimeout.promise
        .then(async () => {
            didTimeout = true;
            await cleanup();
            await dynamo[poolTable].delete({ pk: poolName, sk: lockId });
        })
        .catch((e) => {
            if (e !== "silent") {
                console.log(e);
            }
        });
    await waitUntilOnQueue(dynamo, {
        lockId,
        nowMs,
        poolName,
        poolSize,
        minWaitQueueMs,
        waitVarianceMs,
        maxRetries,
        queryLimit,
        poolTable,
    });

    let result = null;
    if (didTimeout === false) {
        result = await operation();
    } else {
        throw new Error("timed out");
    }
    if (didTimeout === false) {
        maxTimeout.cancel("silent");
        await cleanup();
        await dynamo[poolTable].delete({ pk: poolName, sk: lockId });
    }
    return result;
}

async function waitUntilOnQueue(
    dynamo,
    { lockId, nowMs, poolName, poolSize, minWaitQueueMs, waitVarianceMs, maxRetries, poolTable }
) {
    let maxTimeToQueue = await checkQueue(dynamo, { lockId, nowMs, poolName, poolSize, poolTable });
    let retries = 0;
    while (maxTimeToQueue > Date.now()) {
        retries++;
        if (retries > maxRetries) throw new Error("maximum retries exceeded");
        await wait(
            Math.floor(
                Math.min(Math.max(maxTimeToQueue - Date.now(), 0), minWaitQueueMs + Math.random() * waitVarianceMs)
            )
        );
        maxTimeToQueue = await checkQueue(dynamo, { lockId, nowMs, poolName, poolSize, poolTable });
    }
}

async function checkQueue(dynamo, { queryLimit, poolName, poolSize, nowMs, lockId, poolTable }) {
    let poolQuery = await dynamo[poolTable].query({
        ExpressionAttributeNames: { "#p": "pk" },
        KeyConditionExpression: "#p = :p ",
        ExpressionAttributeValues: { ":p": poolName },
        ScanIndexForward: false,
        Limit: queryLimit,
        ConsistentRead: true,
    });
    let pool = poolQuery.Items.filter((item) => item.exp >= nowMs);
    let orderedQue = pool.slice().sort((a, b) => (a.sk > b.sk ? 1 : -1));
    let myIndexInQue = orderedQue.map((item) => item.sk).indexOf(lockId);
    let expirationTimesBeforeMe = orderedQue.slice(0, myIndexInQue).sort((a, b) => (a.exp > b.exp ? 1 : -1));
    let maxTimeToQue = myIndexInQue > poolSize - 1 ? expirationTimesBeforeMe[myIndexInQue - poolSize].exp : Date.now();
    return maxTimeToQue;
}

function timeoutWithCancel(ms, value) {
    let promise, _timeout, cancel;
    promise = new Promise(function (resolve, reject) {
        _timeout = setTimeout(function () {
            resolve(value);
        }, ms);
        cancel = function (err) {
            reject(err || new Error("Timeout Cancelled"));
            clearTimeout(_timeout);
        };
    });
    return { promise, cancel };
}

function wait(ms, value = null) {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

module.exports = { dpool, wait };
