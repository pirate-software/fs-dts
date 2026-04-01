import { z } from "zod";
import { OldPlaygroups, oldPlaygroupsSchema, VersionedApiJson, versionedApiJsonSchema } from "../util";
import { promises as fs } from "fs";
import sharp from "sharp";
import { SCHEMA_VERSION_ID, ApiMeta, apiMetaSchema } from "@pirate-software/fs-data/build/api";
import { Logger } from "../logger";

export const imageMetadataFileSchema = z.object({
   "mugshots": z.record(z.string(), z.object({
       path: z.string(),
        lastUpdateTimestamp: z.string().max(50)
   }))
});
export type ImageMetadataFile = z.infer<typeof imageMetadataFileSchema>;

export const publicRoot = "./public";
export const privateRoot = "./private";
const ferretsJsonFilename = "ferrets.json";
const ferretsMetaJsonFilename = "ferrets.meta.json";
const outnowJsonFilename = "outnow.json";
const imageMetaFilename = "images.meta.json";
const oldPlaygroupsJsonFilename = "oldplaygroups.json";

export class FileHandler {
    logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    //#region File Handling
    public async saveThumbnail(ferretSlug: string, url: string, type: "mugshots" | "playgroups"): Promise<string> {
        const mugshotPath = `${publicRoot}/${type}/${ferretSlug}.png`;

        const res = await fetch(url);
        const buffer = await res.arrayBuffer();

        // crop, resize, and jpeg
        const image = sharp(Buffer.from(buffer));
        const metadata = await image.metadata();
        const width = metadata.width || 512;
        const height = metadata.height || 512;
        const left = Math.floor(width * 0.15);
        const top = Math.floor(height * 0.10);
        const right = Math.floor(width * 0.85);
        const bottom = Math.floor(height * 0.75);
        const cropped = image.extract({ left: left, top: top, width: right - left, height: bottom - top });
        const resized = cropped.resize(512, 512, { fit: 'inside', withoutEnlargement: true });
        const finalBuffer = await resized.jpeg({ quality: 80 }).toBuffer();

        // create public/{type} directory if it doesn't exist
        if (!(await fs.stat(`${publicRoot}/${type}`).catch(() => false)))
        {
            await fs.mkdir(`${publicRoot}/${type}`, { recursive: false });
        }
        // delete existing file if it exists
        await fs.rm(`${mugshotPath}`, { force: true });
        // write new file
        await fs.writeFile(`${mugshotPath}`, finalBuffer);
        return mugshotPath;
    }

    public async getImageMetaFile(): Promise<ImageMetadataFile> {
        const imageMetaPath = `${privateRoot}/${imageMetaFilename}`;
        if (!(await fs.stat(privateRoot).catch(() => false)) || !(await fs.stat(imageMetaPath).catch(() => false))) {
            // file doesn't exist
            return { mugshots: {} };
        }

        const data = await fs.readFile(imageMetaPath, "utf-8");
        const parsed = imageMetadataFileSchema.parse(JSON.parse(data));
        return parsed;
    }

    public async saveImageMetaFile(data: ImageMetadataFile): Promise<void> {
        const imageMetaPath = `${privateRoot}/${imageMetaFilename}`;
        if (!(await fs.stat(privateRoot).catch(() => false))) {
            // create private directory
            await fs.mkdir(privateRoot, { recursive: false });
        }
        await fs.writeFile(imageMetaPath, JSON.stringify(data, null, 2), "utf-8");
    }

    public async getOutNowJson(): Promise<VersionedApiJson> {
        return this.getVersionedApiJson(`${publicRoot}/${outnowJsonFilename}`);
    }

    public async writeOutNowJson(data: VersionedApiJson): Promise<void> {
        const outnowJsonPath = `${publicRoot}/${outnowJsonFilename}`;
        await fs.writeFile(outnowJsonPath, JSON.stringify(data, null, 2), "utf-8");
    }

    public async getFerretsJson(): Promise<VersionedApiJson> {
        return this.getVersionedApiJson(`${publicRoot}/${ferretsJsonFilename}`);
    }

    private async getVersionedApiJson(path: string): Promise<VersionedApiJson> {
        let parsed: VersionedApiJson;
        try {
            const data = await fs.readFile(path, "utf-8");
            parsed = versionedApiJsonSchema.parse(JSON.parse(data));
        } catch (e) {
            this.logger.warn(`Error reading/parsing current ${ferretsJsonFilename} file:`, e);
            this.logger.warn(`Assuming no existing ${ferretsJsonFilename} file.`);
            return {};
        }
        return parsed;
    }

    public async saveFerretsJson(data: VersionedApiJson): Promise<void> {
        const ferretsJsonPath = `${publicRoot}/${ferretsJsonFilename}`;
        await fs.writeFile(ferretsJsonPath, JSON.stringify(data, null, 2), "utf-8");
    }

    public async getFerretsMetaFile(): Promise<ApiMeta> {
        const metaFilePath = `${publicRoot}/${ferretsMetaJsonFilename}`;
        let parsed: ApiMeta;
        try {
            const data = await fs.readFile(metaFilePath, "utf-8");
            parsed = apiMetaSchema.parse(JSON.parse(data));
        } catch (e) {
            this.logger.warn(`Error reading/parsing current ${ferretsMetaJsonFilename} file:`, e);
            this.logger.warn(`Assuming no existing ${ferretsMetaJsonFilename} file.`);
            return {
                apiVersion: {
                    min: SCHEMA_VERSION_ID,
                    current: SCHEMA_VERSION_ID
                },
                lastUpdated: new Date().toISOString()
            };
        }
        return parsed;
    }

    public async saveFerretsMetaFile(data: ApiMeta): Promise<void> {
        const metaFilePath = `${publicRoot}/${ferretsMetaJsonFilename}`;
        await fs.writeFile(metaFilePath, JSON.stringify(data, null, 2), "utf-8");
    }

    public async loadOldPlaygroups(): Promise<OldPlaygroups> {
        const oldPlaygroupsPath = `${privateRoot}/${oldPlaygroupsJsonFilename}`;
        if (!(await fs.stat(oldPlaygroupsPath).catch(() => false))) {
            this.logger.warn("Old playgroups file not found, returning empty playgroups");
            return {};
        }
        const data = await fs.readFile(oldPlaygroupsPath, "utf-8");
        return oldPlaygroupsSchema.parse(JSON.parse(data));
    }
    //#endregion
}