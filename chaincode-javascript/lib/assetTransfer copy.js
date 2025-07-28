'use strict';

const stringify = require('json-stringify-deterministic');
const sortKeysRecursive = require('sort-keys-recursive');
const { Contract } = require('fabric-contract-api');
const crypto = require('crypto');

class AssetTransfer extends Contract {

    async CreateAsset(ctx, id, source, batteryCapacity, loadPower, consumedPower, durationMinutes, timestamp) {
        const exists = await this.AssetExists(ctx, id);
        if (exists) {
            throw new Error(`The asset ${id} already exists`);
        }

        const asset = {
            ID: id,
            Source: source,
            BatteryCapacity: batteryCapacity,
            LoadPower: loadPower,
            ConsumedPower: consumedPower,
            Duration: durationMinutes,
            Timestamp: timestamp,
        };

        const assetString = stringify(sortKeysRecursive(asset));
        const hash = crypto.createHash('sha256').update(assetString).digest('hex');

        asset.Hash = hash; // tambahkan hash ke asset
        await ctx.stub.putState(id, Buffer.from(stringify(sortKeysRecursive(asset))));
        return JSON.stringify(asset);
    }

    async ReadAsset(ctx, id) {
        const assetJSON = await ctx.stub.getState(id);
        if (!assetJSON || assetJSON.length === 0) {
            throw new Error(`The asset ${id} does not exist`);
        }
        return assetJSON.toString();
    }

    async AssetExists(ctx, id) {
        const assetJSON = await ctx.stub.getState(id);
        return assetJSON && assetJSON.length > 0;
    }

    async GetAllAssets(ctx) {
        const allResults = [];
        const iterator = await ctx.stub.getStateByRange('', '');
        let result = await iterator.next();
        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString()).toString('utf8');
            let record;
            try {
                record = JSON.parse(strValue);
            } catch (err) {
                console.log(err);
                record = strValue;
            }
            allResults.push(record);
            result = await iterator.next();
        }
        return JSON.stringify(allResults);
    }

  
    async ValidateAsset(ctx, id) {
        const assetJSON = await ctx.stub.getState(id);
        if (!assetJSON || assetJSON.length === 0) {
            throw new Error(`Asset ${id} does not exist`);
        }

        const asset = JSON.parse(assetJSON.toString());
        const originalHash = asset.Hash;
        delete asset.Hash;

        const recalculatedHash = crypto
            .createHash('sha256')
            .update(stringify(sortKeysRecursive(asset)))
            .digest('hex');

        if (originalHash !== recalculatedHash) {
            throw new Error(`Asset ${id} has been tampered! Hash mismatch.`);
        }

        return `Asset ${id} is valid and untampered.`;
    }

   
    async GetAssetHistory(ctx, id) {
        const results = [];
        const iterator = await ctx.stub.getHistoryForKey(id);
        let result = await iterator.next();
        while (!result.done) {
            const record = {
                txId: result.value.txId,
                timestamp: result.value.timestamp,
                isDelete: result.value.isDelete,
                value: JSON.parse(result.value.value.toString('utf8')),
            };
            results.push(record);
            result = await iterator.next();
        }
        return JSON.stringify(results);
    }
}

module.exports = AssetTransfer;
