import { Ferret, ferretSchema } from "@pirate-software/fs-data/build/ferrets/core";
import { SCHEMA_VERSION_ID, ApiData } from "@pirate-software/fs-data/build/api";
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

const metaFileSchema = z.object({
    apiVersion: z.object({
        min: z.string(),
        current: z.string()
    }),
    lastUpdated: z.string()
});
type MetaFile = z.infer<typeof metaFileSchema>;

const ferretsJsonSchema = z.record(z.string(), z.any());
type FerretsJson = z.infer<typeof ferretsJsonSchema>;

type SquareBracketNest<T> = { open: number; close: number; children: SquareBracketNest<T>[] };
interface SquareBracketNestNode extends SquareBracketNest<SquareBracketNestNode> {}

const publicRoot = "./public";
const privateRoot = "./private";

export class DTS {
    wikiApiBaseUrl: string;
    wikiPageRoot: string;
    apiBaseUrl: string;
    
    constructor(wikiApiBaseUrl: string, wikiPageRoot: string, apiBaseUrl: string) {
        this.wikiApiBaseUrl = wikiApiBaseUrl;
        this.wikiPageRoot = wikiPageRoot;
        if (!this.wikiPageRoot.endsWith("/")) {
            this.wikiPageRoot += "/";
        }
        this.apiBaseUrl = apiBaseUrl;
        if (!this.apiBaseUrl.endsWith("/")) {
            this.apiBaseUrl += "/";
        }
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
     * @throws {Error} if year < 2000 or month/day invalid
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
     * @throws {Error} if month or day missing or invalid
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

    /**
     * Parses nested double square brackets in a string.
     * @param s input string
     * @returns array of root SquareBracketNestNodes (each represents a [[...]] section, with children for nested [[...]] sections)
     * @throws {Error} if unmatched brackets in string
     */
    private static _getDoubleSquareBracketNests(s: string): Array<SquareBracketNestNode> {
        let stack: Array<SquareBracketNestNode> = [];
        let roots: Array<SquareBracketNestNode> = [];
        for (let i = 0; i < s.length - 1; i++) {
            if (s[i] === "[" && s[i + 1] === "[") {
                const newNode: SquareBracketNestNode = { open: i, close: -1, children: [] };
                if (stack.length > 0) {
                    stack[stack.length - 1].children.push(newNode);
                } else {
                    roots.push(newNode);
                }
                stack.push(newNode);
                i++; // skip second [
            } else if (s[i] === "]" && s[i + 1] === "]") {
                if (stack.length === 0) {
                    throw new Error(`Unmatched closing brackets at position ${i} in string "${s}"`);
                }
                const node = stack.pop()!;
                node.close = i + 1;
                i++; // skip second ]
            }
        }
        if (stack.length > 0) {
            throw new Error(`Unmatched opening brackets at position ${stack[0].open} in string "${s}"`);
        }
        return roots;
    }

    /**
     * Processes wikitext to plain text, preserving internal links only for linkable ferrets.
     * @param s wikitext string
     * @param isLinkableFerret function to determine if a link target is a linkable ferret, if so links to it are preserved in [[Link|Text]] format
     * @returns processed string
     * @throws {Error} if unmatched brackets in wikitext
     */
    private static processWikitext(s: string, isLinkableFerret: (name: string) => boolean): string {
        let subbed = s
            .replace(/\[http[^\s]* ([^\]]+)\]/g, "$1") // Remove external links
            .replace(/''+/g, "") // Remove italics/bold
            .replace(/<ref.*?>.*?<\/ref>/g, "") // Remove references
            .replace(/<.*?>/g, "") // Remove other HTML tags
            .replace(/\{\{.*?\}\}/g, ""); // Remove templates
        
        // Process internal links
        const nests = DTS._getDoubleSquareBracketNests(s);
        
        let out = "";
        let lastIndex = 0;
        for (const nest of nests) {
            out += subbed.slice(lastIndex, nest.open);
            const innerText = s.slice(nest.open + 2, nest.close - 2);
            if (!innerText.match(/^File:/)) { // ignore file links completely (since inner text is caption)
                const linkMatch = /^([^\|\]]*)(\|[^\]]+)?$/.exec(innerText);
                if (linkMatch) { // In-wiki link
                    const linkTarget = linkMatch[1].trim();
                    const linkText = (linkMatch[2]) ? linkMatch[2].slice(1).trim() : linkTarget;
                    if (isLinkableFerret(linkTarget)) {
                        out += `[[${linkTarget}|${linkText}]]`;
                    } else { // Just keep text of non-ferret links
                        out += linkText;
                    }
                }
            }
            lastIndex = nest.close;
        }
        out += subbed.slice(lastIndex);

        return out.trim();
    }
    
    /**
     * Gets mediawiki action API response for given parameters.
     * @param params wiki API parameters
     * @returns parsed JSON response
     * @throws {Error} if JSON parsing fails
     */
    private async getWikiAPI(params: Record<string, string>): Promise<any> {
        const res: Response = await fetch(this.wikiApiBaseUrl + "?" + new URLSearchParams(params).toString());
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

    private async getPageWikitext(wikiPage: string): Promise<string> {
        const params = {
            "action": "parse",
            "page": wikiPage,
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

    private async parseFerretWikitext(wikitext: string, isLinkableFerret: (wikiPage: string) => boolean): Promise<{summary: string, lore: string, aliases: string[]}> {
        const pageContentMatch = /^(?:<!--[\s\S]*?-->\s*)*\s*\{\{Infobox Ferret([\s\S]*?)\}\}([\s\S]*)\n\s*==\s*Lore\s*==([\s\S]*?)(\n\s*==|$)/.exec(wikitext);
        if (!pageContentMatch) {
            throw new Error("Infobox or lore section header misformatted.");
        }
        
        const infoboxContent = /\|[ \t]*(\w+)[ \t]*=[ \t]*(.*)/g.exec(pageContentMatch[1]);
        if (!infoboxContent) {
            throw new Error("Infobox content misformatted.");
        }
        
        let aliases: string[] = [];
        for (let i = 0; i < infoboxContent.length; i+=2) {
            const field = infoboxContent[i];
            const value = infoboxContent[i + 1];
            if (/^(nickname|shayename)s?$/i.test(field)) {
                aliases.push(...value.split(",").map(s => s.trim()).filter(s => s.length > 0));
            }
        }

        let summary = DTS.processWikitext(pageContentMatch[2].trim(), isLinkableFerret);
        if (summary.length < 100 && summary.endsWith("lacking intro")) { // missing summary
            summary = "";
        }

        const lore = DTS.processWikitext(pageContentMatch[3].trim(), isLinkableFerret);

        return { summary, lore, aliases };
    }

    private async updateFerret(tableEntry: FerretTableEntry, ferretsTable: FerretTableEntry[], imageMeta: ImageMetadataFile): Promise<Ferret> {
        const name = tableEntry.name;
        const wikiPage = DTS.nameAsWikiPageUrl(name);

        // Parse wiki page details
        let wikiText: string, summary: string, lore: string, aliases: string[];
        try {
            wikiText = await this.getPageWikitext(wikiPage);
        } catch (e) {
            throw new Error(`Failed to get wikitext for ferret "${name}" (wiki page "${wikiPage}"): ${e}`);
        }

        try {
            ({ summary, lore, aliases } = await this.parseFerretWikitext(wikiText, (wikiPage: string) => ferretsTable.some(fe => DTS.nameAsWikiPageUrl(fe.name) === wikiPage)));
        } catch (e) {
            throw new Error(`Failed to parse wikitext for ferret "${name}" (wiki page "${wikiPage}"): ${e}`);
        }

        // Parse table entry
        let birth: PartialDateString | null, birthday: BirthdayString | null, arrival: PartialDateString | null, valhalla: PartialDateString | null;
        try {
            birth = DTS.toDOBString(tableEntry["birth date"]);
        } catch (e) {
            throw new Error(`Failed to parse date of birth for ferret "${name}": ${e}`);
        }

        try {
            birthday = DTS.toBirthdayString(tableEntry["birth date"]);
        } catch (e) {
            throw new Error(`Failed to parse birthday for ferret "${name}": ${e}`);
        }

        try {
            arrival = DTS.toPartialDateString(tableEntry["arrival date"]);
        } catch (e) {
            throw new Error(`Failed to parse arrival date for ferret "${name}": ${e}`);
        }

        try {
            valhalla = DTS.toPartialDateString(tableEntry["valhalla date"]);
        } catch (e) {
            throw new Error(`Failed to parse valhalla date for ferret "${name}": ${e}`);
        }

        // Get mugshot
        let mugshotUrl: string;
        try {
            const ferretSlug = DTS.nameAsSlug(name);
            const { url: mugshotWikiUrl, timestamp: mugshotTimestamp } = await this.getMugshotUrl(name) ?? { url: this.apiBaseUrl + "mugshot_placeholder.png", timestamp: "" };
            if (!imageMeta.mugshots[ferretSlug] || imageMeta.mugshots[ferretSlug].lastUpdateTimestamp !== mugshotTimestamp) {
                const mugshotPath = await this.saveMugshot(ferretSlug, mugshotWikiUrl);
                imageMeta.mugshots[ferretSlug] = {
                    path: mugshotPath,
                    lastUpdateTimestamp: mugshotTimestamp
                }
            }
            if (!imageMeta.mugshots[ferretSlug].path.startsWith(publicRoot)) {
                throw new Error(`Mugshot path "${imageMeta.mugshots[ferretSlug].path}" is not in public root "${publicRoot}"`);
            }
            mugshotUrl = this.apiBaseUrl + imageMeta.mugshots[ferretSlug].path.substring(publicRoot.length+1);
        } catch (e) {
            throw new Error(`Failed to get mugshot for ferret "${name}": ${e}`);
        }

        return {
            name: name,
            wikipage: wikiPage,
            aliases: aliases,
            commands: DTS.nameAsChatCommands(name),
            sex: tableEntry.gender,
            birth: birth,
            birthday: birthday,
            arrival: arrival,
            valhalla: valhalla,
            playgroup: tableEntry.playgroup,
            summary: summary,
            lore: lore,
            clips: [],
            mugshot: mugshotUrl,
            images: [],
            merch: []
        }
    }

    private async getFerretsJson(): Promise<FerretsJson> {
        const ferretsJsonPath = `${publicRoot}/ferrets.json`;
        let parsed: FerretsJson;
        try {
            const data = await fs.readFile(ferretsJsonPath, "utf-8");
            parsed = ferretsJsonSchema.parse(JSON.parse(data));
        } catch (e) {
            console.info("Error reading/parsing current ferrets.json file:", e);
            console.info("Assuming no existing ferrets.json file.");
            return {};
        }
        return parsed;
    }

    private async saveFerretsJson(data: FerretsJson): Promise<void> {
        const ferretsJsonPath = `${publicRoot}/ferrets.json`;
        await fs.writeFile(ferretsJsonPath, JSON.stringify(data, null, 2), "utf-8");
    }

    private async getFerretsMetaFile(): Promise<MetaFile> {
        const metaFilePath = `${publicRoot}/ferrets.meta.json`;
        let parsed: MetaFile;
        try {
            const data = await fs.readFile(metaFilePath, "utf-8");
            parsed = metaFileSchema.parse(JSON.parse(data));
        } catch (e) {
            console.info("Error reading/parsing current ferrets.meta.json file:", e);
            console.info("Assuming no existing ferrets.meta.json file.");
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

    private async saveFerretsMetaFile(data: MetaFile): Promise<void> {
        const metaFilePath = `${publicRoot}/ferrets.meta.json`;
        await fs.writeFile(metaFilePath, JSON.stringify(data, null, 2), "utf-8");
    }

    async updateData(apiMinVersion: string): Promise<void> {
        console.log("Updating data");
    
        console.log("Fetching ferrets table");
        const ferretsTable = await this.getFerretsTable();
        console.log(`Fetched ${ferretsTable.length} ferret entries from table`);

        console.log("Loading image metadata file");
        const imageMeta = await this.getImageMetaFile();
        console.log(`Loaded image metadata for ${Object.keys(imageMeta.mugshots).length} mugshots`);

        let ferrets: Ferret[] = [];
        for (const tableEntry of ferretsTable) {
            console.log(`Processing ferret "${tableEntry.name}"`);
            const ferret = await this.updateFerret(tableEntry, ferretsTable, imageMeta);
            ferrets.push(ferret);
        }
        
        console.log("Getting ferrets.json");
        let ferretsJson: FerretsJson = await this.getFerretsJson();

        console.log("Getting ferrets.meta.json");
        let metaFile: MetaFile = await this.getFerretsMetaFile();

        console.log("Updating ferrets.json");
        const ferretsData: ApiData = {
            ferrets: ferrets
        };
        ferretsJson[SCHEMA_VERSION_ID] = ferretsData;
        await this.saveFerretsJson(ferretsJson);
        console.log("Updated ferrets.json");
        
        console.log("Saving image metadata file");
        await this.saveImageMetaFile(imageMeta);
        console.log("Saved image metadata file");
        
        console.log("Updating ferrets.meta.json");
        metaFile.apiVersion.current = SCHEMA_VERSION_ID;
        metaFile.lastUpdated = new Date().toISOString();
        await this.saveFerretsMetaFile(metaFile);
        console.log("Updated ferrets.meta.json");

        console.log("Data update complete");
    }
}
