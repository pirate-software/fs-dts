import { Ferret, ferretSchema } from "@pirate-software/fs-data/build/ferrets/core";
import { z } from "zod";
import fs from "fs/promises";
import { BirthdayString, PartialDateString, pathSchema } from "@pirate-software/fs-data/build/types";
import { deepEqual } from "assert";

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const asciiSchema = z.string().regex(/^[\x20-\x7E]+$/);

const apiResWikitextSchema = z.object({
    parse: z.object({
        wikitext: z.object({
            "*": z.string()
        })
    })
});

const apiResCargoQuerySchema = z.object({
    cargoquery: z.array(z.object({
        title: z.record(z.string(), z.string())
    }))
});

const apiResMugshotQuerySchema = z.object({
    query: z.object({
        pages: z.record(z.string(), z.object({
            imageinfo: z.array(z.object({
                url: z.url(),
                timestamp: z.string().max(50)
            })).min(1)
        }))
    })
});

const ferretTableEntrySchema = z.object({
    name: asciiSchema,
    gender: z.enum(["Male", "Female"]),
    "arrival date": dateStringSchema.or(z.string().length(0)),
    "birth date": dateStringSchema.or(z.string().length(0)),
    "valhalla date": dateStringSchema.or(z.string().length(0)),
    playgroup: asciiSchema
});
type FerretTableEntry = z.infer<typeof ferretTableEntrySchema>;

const imageMetadataFileSchema = z.object({
   "mugshots": z.record(z.string(), z.object({
       path: z.string(),
        lastUpdateTimestamp: z.string().max(50)
   }))
});
type ImageMetadataFile = z.infer<typeof imageMetadataFileSchema>;

const publicRoot = "./public";
const privateRoot = "./private";

export class DTS {
    wikiBaseUrl: string;
    apiBaseUrl: string;
    
    constructor(wikiBaseUrl: string, apiBaseUrl: string) {
        this.wikiBaseUrl = wikiBaseUrl;
        this.apiBaseUrl = apiBaseUrl;
    }

    private static nameAsSlug(name: string): string {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    }

    /**
     * Chat commands for ferret (excluding !), also allows singular if ends with s. (ie, "Beans" -> "show beans" and "show bean")
     * @param name ferret name, with spaces (ie "Mai Tai")
     * @returns array of chat commands, excluding !s (all lowercase with no spaces in ferret name)
     */
    private static nameAsChatCommands(name: string): string[] {
        let commands: string[] = [];
        let cleanName = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
        commands.push(`show ${cleanName}`);
        if (cleanName.endsWith("s")) {
            commands.push(`show ${cleanName.slice(0, -1)}`);
        }
        return commands;
    }

    /**
     * From spaces to capitalised with underscores.
     * @param name ferret name with spaces, ie "Mai Tai"
     * @returns 
     */
    static nameAsWikiPageUrl(name: string): string { // 
        return name.split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join("_");
    }

    /**
     * Helper function splitting and parsing yyyy-mm-dd or yyyy-mm or yyyy into parts. Does not validate ranges.
     * @param date date string in yyyy-mm-dd or yyyy-mm or yyyy format
     * @returns year, month, day as numbers (month and day may be null)
     */
    private static _toDateParts(date: string): { year: number; month: number | null; day: number | null } {
        const parts = date.split("-").map(part => parseInt(part));
        let y: number;
        let m, d: number | null;
        switch (parts.length) {
            case 3:
                [y, m, d] = parts;
                break;
            case 2:
                [y, m] = parts;
                d = null;
                break;
            case 1:
                [y] = parts;
                m = null;
                d = null;
                break;
            default:
                throw new Error(`Invalid date format: "${date}". Expected yyyy or yyyy-mm or yyyy-mm-dd.`);
        }
        return { year: y, month: m, day: d };
    }

    private static _validateMonthDay(m: number, d: number | null): boolean {
        const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (m < 1 || m > 12) return false;
        if (d && (d < 1 || d > daysInMonth[m - 1])) return false;
        return true;
    }

    private static _padString = (n: number, d: number) => n.toString().padStart(d, "0");

    /**
     * Convert a date string output from wiki table to PartialDateString
     * @param date yyyy, yyyy-mm, yyyy-mm-dd, or empty
     * @returns partial date string or null if empty
     */
    private static toPartialDateString(date: string): PartialDateString | null {
        if (date.length === 0) return null;

        // get parts
        const { year: y, month: m, day: d } = DTS._toDateParts(date);

        // validation
        if (y < 2000) {
            throw new Error(`Invalid year in date (< 2000) "${date}": "${y}"`);
        }
        if (m && !DTS._validateMonthDay(m, d)) {
            throw new Error(`Invalid month/day in date "${date}": month="${m}", day="${d}"`);
        }

        // out string
        const pad = DTS._padString;
        if (y && m && d) {
            return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}` as PartialDateString;
        } else if (y && m) {
            return `${pad(y, 4)}-${pad(m, 2)}` as PartialDateString;
        } else {
            return `${pad(y!, 4)}` as PartialDateString;
        }
    }

    /**
     * Convert a date string output from wiki table (yyyy-mm-dd) to BirthdayString (mm-dd only)
     * @param date Date which may have a year
     * @returns birthday string or null if empty
     */
    private static toBirthdayString(date: string): BirthdayString | null {
        if (date.length === 0) return null;

        // get parts
        const { month: m, day: d } = DTS._toDateParts(date);
        
        if (!m || !d) {
            throw new Error(`Invalid birthday date (missing month or day) "${date}": month="${m}", day="${d}"`);
        }
        if (!DTS._validateMonthDay(m, d)) {
            throw new Error(`Invalid month/day in birthday date "${date}": month="${m}", day="${d}"`);
        }

        const pad = DTS._padString;
        return `${pad(m, 2)}-${pad(d, 2)}` as BirthdayString;
    }

    /**
     * Convert a date string output from wiki table to PartialDateString, only if year >= 2000
     * @param date Date which may have a year < 2000
     * @returns partial date string or null if year < 2000
     */
    private static toDOBString(date: string): PartialDateString | null {
        if (date.length === 0) return null;
        const { year: y } = DTS._toDateParts(date);
        if (y < 2000) return null;
        return DTS.toPartialDateString(date);
    }
    
    private async getWikiAPI(params: Record<string, string>): Promise<any> {
        const res: Response = await fetch(this.wikiBaseUrl + "?" + new URLSearchParams(params).toString());
        try {
            const json = await res.json();
            return json;
        } catch (e) {
            console.error("Error parsing JSON from wiki API response");
            console.error("Response text:", await res.text());
            console.error("Error:", e);
            throw e;
        }
    }

    private async getPageWikitext(title: string): Promise<string> {
        const params = {
            "action": "parse",
            "page": title.replace(/ /g, "_"),
            "format": "json",
            "prop": "wikitext"
        }
        const res = await this.getWikiAPI(params);
        const parsed = apiResWikitextSchema.parse(res);
        const wikitext = parsed.parse.wikitext["*"];
        return wikitext;
    }

    private async getCargoTable(table: string, fields: string[]): Promise<any[]> {
        let out: any[] = [];
        const maxPerQuery = 500;
        let offset = 0;
        let params = {
            "action": "cargoquery",
            "tables": table,
            "limit": maxPerQuery.toString(),
            "fields": fields.join(","),
            "format": "json",
            "offset": offset.toString()
        }
        do {
            params.offset = offset.toString();
            const res = await this.getWikiAPI(params);
            const parsed = apiResCargoQuerySchema.parse(res);
            out = out.concat(parsed.cargoquery.map(item => item.title));

            if (parsed.cargoquery.length < maxPerQuery) {
                break;
            }
            offset += maxPerQuery;
        } while (offset < 10000);

        return out;
    }

    private async getFerretsTable(): Promise<FerretTableEntry[]> {
        const rows = await this.getCargoTable("Ferrets", ["name", "gender", "arrival_date", "birth_date", "valhalla_date", "playgroup"]);
        return rows.map(row => ferretTableEntrySchema.parse(row));
    }

    private async getMugshotUrl(ferretName: string): Promise<{url: string, timestamp: string} | null> {
        const params = {
            "action": "query",
            "titles": `File:${ferretName}_Mugshot.png`,
            "prop": "imageinfo",
            "iiprop": "url|timestamp",
            "format": "json"
        }
        const res = await this.getWikiAPI(params);
        const parsed = apiResMugshotQuerySchema.parse(res);
        const pages = parsed.query.pages;
        for (const pageId in pages) {
            const page = pages[pageId];
            if (page.imageinfo && page.imageinfo.length > 0) {
                return {
                    url: page.imageinfo[0].url,
                    timestamp: page.imageinfo[0].timestamp
                };
            }
        }
        return null;
    }

    private async saveMugshot(ferretSlug: string, url: string): Promise<string> {
        const mugshotPath = `${publicRoot}/mugshots/${ferretSlug}.png`;

        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        // create public/mugshots directory if it doesn't exist
        if (!(await fs.stat(`${publicRoot}/mugshots`).catch(() => false)))
        {
            await fs.mkdir(`${publicRoot}/mugshots`, { recursive: false });
        }
        // delete existing file if it exists
        await fs.rm(`${mugshotPath}`, { force: true });
        // write new file
        await fs.writeFile(`${mugshotPath}`, Buffer.from(buffer));
        return mugshotPath;
    }

    private async getFerret(tableEntry: FerretTableEntry): Promise<Ferret> {
        return {
            name: tableEntry.name,
            wikipage: DTS.nameAsWikiPageUrl(tableEntry.name),
            aliases: [], //todo
            commands: DTS.nameAsChatCommands(tableEntry.name),
            sex: tableEntry.gender,
            birth: null, //todo
            birthday: null, //todo
            arrival: null, //todo
            valhalla: null, //todo
            playgroup: tableEntry.playgroup,
            summary: "", //todo
            lore: "", //todo
            clips: [],
            mugshot: "", //todo
            images: [],
            merch: []
        }
    }

    private async getImageMetaFile(): Promise<ImageMetadataFile> {
        const imageMetaPath = `${privateRoot}/image-metadata.json`;
        if (!(await fs.stat(privateRoot).catch(() => false)) || !(await fs.stat(imageMetaPath).catch(() => false))) {
            // file doesn't exist
            return { mugshots: {} };
        }

        const data = await fs.readFile(imageMetaPath, "utf-8");
        const parsed = imageMetadataFileSchema.parse(JSON.parse(data));
        return parsed;
    }

    private async saveImageMetaFile(data: ImageMetadataFile): Promise<void> {
        const imageMetaPath = `${privateRoot}/image-metadata.json`;
        if (!(await fs.stat(privateRoot).catch(() => false))) {
            // create private directory
            await fs.mkdir(privateRoot, { recursive: false });
        }
        await fs.writeFile(imageMetaPath, JSON.stringify(data, null, 2), "utf-8");
    }

    async updateData(): Promise<void> {
        console.log("Updating data");
    
        console.log("Fetching")
        const imageMeta = await this.getImageMetaFile();
        const ferretName = "Beans";
        const ferretSlug = DTS.nameAsSlug(ferretName);
        const { url: fUrl, timestamp: fts } = (await this.getMugshotUrl(ferretName))!;
        console.log(`Mugshot URL: ${fUrl}, timestamp: ${fts}`);

        if (imageMeta.mugshots[ferretSlug]?.lastUpdateTimestamp === fts) {
            console.log("Mugshot is up to date, no changes needed");
        } else {
            await this.saveMugshot(ferretSlug, fUrl!);
            console.log("Saved new mugshot");
            imageMeta.mugshots[ferretSlug] = fts;
            await this.saveImageMetaFile(imageMeta);
            console.log("Saved image metadata file");
        }

        console.log("Data update complete");
        

        // let ferrets = (await this.getFerretsTable());
        // await this.getPageWikitext("Beans");

        // https://github.com/pirate-software/fs-data/blob/main/wikiscraper/scrape.py#L19
    }
}
