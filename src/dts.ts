import { Ferret, ferretSchema } from "@pirate-software/fs-data/build/ferrets/core";
import { Playgroup, playgroupSchema } from "@pirate-software/fs-data/build/ferrets/playgroups";
import { SCHEMA_VERSION_ID, FerretsApiData, OutNowFerretsData, ApiMeta, apiMetaSchema } from "@pirate-software/fs-data/build/api";
import { z } from "zod";
import fs from "fs/promises";
import { BirthdayString, PartialDateString, pathSchema } from "@pirate-software/fs-data/build/types";
import { deepEqual } from "assert";
import { queryObjects } from "v8";
import { info } from "console";

//#region MW API Query Schemas
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

const apiResCategoryQuerySchema = z.object({
    continue: z.object({
        cmcontinue: z.string()
    }).optional(),
    query: z.object({
        categorymembers: z.array(z.object({
            pageid: z.number(),
            title: z.string()
        }))
    })
});
//#endregion

//#region Data Schemas
const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const asciiSchema = z.string().regex(/^[\x20-\x7E]+$/);

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

const oldPlaygroupsSchema = z.record(z.string(), z.object({
    name: asciiSchema,
    description: z.string()
}));
type OldPlaygroups = z.infer<typeof oldPlaygroupsSchema>;

const versionedApiJsonSchema = z.record(z.string(), z.any());
type VersionedApiJson = z.infer<typeof versionedApiJsonSchema>;
//#endregion

// Non-schema types
type SquareBracketNest<T> = { open: number; close: number; children: SquareBracketNest<T>[] };
interface SquareBracketNestNode extends SquareBracketNest<SquareBracketNestNode> {}

// Consts
const publicRoot = "./public";
const privateRoot = "./private";
const ferretsJsonFilename = "ferrets.json";
const ferretsMetaJsonFilename = "ferrets.meta.json";
const outnowJsonFilename = "outnow.json";
const imageMetaFilename = "images.meta.json";
const oldPlaygroupsJsonFilename = "oldplaygroups.json";
const mugshotPlaceholderFilename = "mugshot_placeholder.png";

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

    //#region Static utility functions
    private static nameAsSlug(name: string): string {
        return name.toLowerCase().replace(/[^a-z0-9]+/gi, "-");
    }

    /**
     * Chat commands for ferret (excluding !), also allows singular if ends with s. (ie, "Beans" -> "show beans" and "show bean")
     * @param name ferret name, with spaces (ie "Mai Tai")
     * @returns array of chat commands, excluding !s (all lowercase with no spaces in ferret name)
     */
    private static nameAsChatCommands(name: string): string[] {
        let commands: string[] = [];
        let cleanName = name.toLowerCase().replace(/[^a-z0-9]+/gi, "");
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
    private static processWikitext(s: string, includeLinks: boolean, isLinkableFerret: (name: string) => boolean = () => false): string {
        let subbed = s
            .replace(/\[http[^\s]* ([^\]]+)\]/gi, "$1") // Remove external links
            .replace(/''+/gi, "") // Remove italics/bold
            .replace(/<ref.*?>.*?<\/ref>/gi, "") // Remove references
            .replace(/<.*?>/gi, "") // Remove other HTML tags
            .replace(/\{\{.*?\}\}/gi, ""); // Remove templates
        
        // Process internal links
        const nests = DTS._getDoubleSquareBracketNests(subbed);
        
        let out = "";
        let lastIndex = 0;
        for (const nest of nests) {
            out += subbed.slice(lastIndex, nest.open);
            const innerText = subbed.slice(nest.open+2, nest.close-1);
            if (!innerText.match(/^File:/)) { // ignore file links completely (since inner text is caption)
                const linkMatch = /^([^\|\]]*)(\|[^\]]+)?$/.exec(innerText);
                if (linkMatch) { // In-wiki link
                    const linkTarget = linkMatch[1].trim();
                    const linkText = (linkMatch[2]) ? linkMatch[2].slice(1).trim() : linkTarget;
                    if (includeLinks && isLinkableFerret(linkTarget)) {
                        out += `[[${linkTarget}|${linkText}]]`;
                    } else { // Just keep text of non-ferret links
                        out += linkText;
                    }
                }
            }
            lastIndex = nest.close+1;
        }
        out += subbed.slice(lastIndex);

        return out.trim();
    }
    //#endregion
    
    //#region Wiki API functions
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

    private async getWikiAPIParsed<T>(params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
        const res = await this.getWikiAPI(params);
        let parsed: T;
        try {
            parsed = schema.parse(res);
        } catch (e) {
            console.error("Error parsing wiki API response with schema:", e);
            throw e;
        }
        return parsed;
    }

    private async getPageWikitext(wikiPage: string | number): Promise<string> {
        const params: Record<string, string> = {
            "action": "parse",
            "format": "json",
            "prop": "wikitext"
        };
        if (typeof wikiPage === "number") {
            params["pageid"] = wikiPage.toString();
        } else {
            params["page"] = wikiPage;
        }
        const parsed = await this.getWikiAPIParsed(params, apiResWikitextSchema);
        return parsed.parse.wikitext["*"];
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
            const parsed = await this.getWikiAPIParsed(params, apiResCargoQuerySchema);
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
        const parsed = await this.getWikiAPIParsed(params, apiResMugshotQuerySchema);
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

    private async getPlaygroupsList(): Promise<Record<string, number>> {
        const playgroups: Record<string, number> = {};
        let cmcontinue: string | null = null;
        do {
            const params: Record<string, string> = {
                "action": "query",
                "list": "categorymembers",
                "cmtitle": "Category:Playgroups",
                "cmtype": "page",
                "cmlimit": "max",
                "format": "json"
            };
            if (cmcontinue) {
                params["cmcontinue"] = cmcontinue;
            }
            const parsed = await this.getWikiAPIParsed(params, apiResCategoryQuerySchema);
            for (const member of parsed.query.categorymembers) {
                playgroups[member.title] = member.pageid;
            }
            cmcontinue = parsed.continue?.cmcontinue || null;
        } while (cmcontinue);
        return playgroups;
    }
    //#endregion

    //#region File Handling
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
        const imageMetaPath = `${privateRoot}/${imageMetaFilename}`;
        if (!(await fs.stat(privateRoot).catch(() => false)) || !(await fs.stat(imageMetaPath).catch(() => false))) {
            // file doesn't exist
            return { mugshots: {} };
        }

        const data = await fs.readFile(imageMetaPath, "utf-8");
        const parsed = imageMetadataFileSchema.parse(JSON.parse(data));
        return parsed;
    }

    private async saveImageMetaFile(data: ImageMetadataFile): Promise<void> {
        const imageMetaPath = `${privateRoot}/${imageMetaFilename}`;
        if (!(await fs.stat(privateRoot).catch(() => false))) {
            // create private directory
            await fs.mkdir(privateRoot, { recursive: false });
        }
        await fs.writeFile(imageMetaPath, JSON.stringify(data, null, 2), "utf-8");
    }

    private async getVersionedApiJson(path: string): Promise<VersionedApiJson> {
        let parsed: VersionedApiJson;
        try {
            const data = await fs.readFile(path, "utf-8");
            parsed = versionedApiJsonSchema.parse(JSON.parse(data));
        } catch (e) {
            console.info(`Error reading/parsing current ${ferretsJsonFilename} file:`, e);
            console.info(`Assuming no existing ${ferretsJsonFilename} file.`);
            return {};
        }
        return parsed;
    }

    private async saveFerretsJson(data: VersionedApiJson): Promise<void> {
        const ferretsJsonPath = `${publicRoot}/${ferretsJsonFilename}`;
        await fs.writeFile(ferretsJsonPath, JSON.stringify(data, null, 2), "utf-8");
    }

    private async getFerretsMetaFile(): Promise<ApiMeta> {
        const metaFilePath = `${publicRoot}/${ferretsMetaJsonFilename}`;
        let parsed: ApiMeta;
        try {
            const data = await fs.readFile(metaFilePath, "utf-8");
            parsed = apiMetaSchema.parse(JSON.parse(data));
        } catch (e) {
            console.info(`Error reading/parsing current ${ferretsMetaJsonFilename} file:`, e);
            console.info(`Assuming no existing ${ferretsMetaJsonFilename} file.`);
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

    private async saveFerretsMetaFile(data: ApiMeta): Promise<void> {
        const metaFilePath = `${publicRoot}/${ferretsMetaJsonFilename}`;
        await fs.writeFile(metaFilePath, JSON.stringify(data, null, 2), "utf-8");
    }

    private async loadOldPlaygroups(): Promise<OldPlaygroups> {
        const oldPlaygroupsPath = `${privateRoot}/${oldPlaygroupsJsonFilename}`;
        if (!(await fs.stat(oldPlaygroupsPath).catch(() => false))) {
            console.log("Old playgroups file not found, returning empty playgroups");
            return {};
        }
        const data = await fs.readFile(oldPlaygroupsPath, "utf-8");
        return oldPlaygroupsSchema.parse(JSON.parse(data));
    }
    //#endregion

    private async parseInfoboxContent(infoboxContent: string): Promise<Record<string, string>> {
        const content = /\|[ \t]*(\w+)[ \t]*=[ \t]*(.*)/gi.exec(infoboxContent);
        const contentRegexPlaintext = "Expects lines of text"

        if (!content) {
            throw new Error("Infobox content misformatted: " + infoboxContent);
        }

        if (content.length % 2 !== 1) {
            throw new Error("Infobox content has uneven number of fields/values. Likely bad regex: " + infoboxContent);
        }

        const fields: Record<string, string> = {};
        for (let i = 0; i < content.length; i+=2) {
            const field = content[i];
            const value = content[i + 1];
            fields[field] = value;
        }

        return fields;
    }

    private async parseFerretWikitext(wikitext: string, isLinkableFerret: (wikiPage: string) => boolean): Promise<{summary: string, lore: string, aliases: string[]}> {
        const pageContentMatch = /^\s*(?:(?:<!--[\s\S]*?-->|{{stub}})\s*)*\s*\{\{Infobox Ferret([\s\S]*?)\}\}([\s\S]*)\n\s*==\s*Lore\s*==([\s\S]*?)(\n\s*==|$)/i.exec(wikitext);
        const pageContentMatchRegexPlaintext = "Expects a page to start with any number of comments or '{{stub}}' (discarded), followed by an '{{Infobox Ferret ...}}', followed by some text (treated as summary), followed by a '== Lore ==' and some text, terminating at either the next '==' found or eof. (One match, case insensitive).";
        
        if (!pageContentMatch) {
            throw new Error("Failed regex parse: Infobox, summary, or lore section header misformatted. " + pageContentMatchRegexPlaintext);
        }
        
        const infoboxContent = await this.parseInfoboxContent(pageContentMatch[1].trim());
        
        let aliases: string[] = [];
        for (const field in infoboxContent) {
            if (/^(nickname|shayename)s?$/i.test(field)) {
                aliases.push(...infoboxContent[field].split(",").map(s => s.trim()).filter(s => s.length > 0));
            }
        }

        let summary = DTS.processWikitext(pageContentMatch[2].trim(), true, isLinkableFerret);
        if (!summary || summary.startsWith("Category:Ferrets lacking intro")) { // missing summary
            summary = "";
        }

        const lore = DTS.processWikitext(pageContentMatch[3].trim(), true, isLinkableFerret);

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
            throw new Error(`Failed to get wikitext (wiki page "${wikiPage}"): ${e}`);
        }

        try {
            ({ summary, lore, aliases } = await this.parseFerretWikitext(wikiText, (wikiPage: string) => ferretsTable.some(fe => DTS.nameAsWikiPageUrl(fe.name) === wikiPage)));
        } catch (e) {
            throw new Error(`Failed to parse wikitext (wiki page "${wikiPage}"): ${e}`);
        }

        // Parse table entry
        let birth: PartialDateString | null, birthday: BirthdayString | null, arrival: PartialDateString | null, valhalla: PartialDateString | null;
        try {
            birth = DTS.toDOBString(tableEntry["birth date"]);
        } catch (e) {
            throw new Error(`Failed to parse date of birth: ${e}`);
        }

        try {
            birthday = DTS.toBirthdayString(tableEntry["birth date"]);
        } catch (e) {
            throw new Error(`Failed to parse birthday: ${e}`);
        }

        try {
            arrival = DTS.toPartialDateString(tableEntry["arrival date"]);
        } catch (e) {
            throw new Error(`Failed to parse arrival date: ${e}`);
        }

        try {
            valhalla = DTS.toPartialDateString(tableEntry["valhalla date"]);
        } catch (e) {
            throw new Error(`Failed to parse valhalla date: ${e}`);
        }

        // fill missing summaries
        if (!summary) {
            summary = `${name} ${valhalla ? "was" : "is"} a rescue ferret of Snails House.`
        }

        // Get mugshot
        let mugshotUrl: string;
        try {
            const ferretSlug = DTS.nameAsSlug(name);
            const { url: mugshotWikiUrl, timestamp: mugshotTimestamp } = await this.getMugshotUrl(name) ?? { url: this.apiBaseUrl + mugshotPlaceholderFilename, timestamp: "" };
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
            throw new Error(`Failed to get mugshot: ${e}`);
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

    private async parsePlaygroupWikitext(wikitext: string): Promise<{summary: string, image: string | null}> {
        const pageContentMatch = /^\s*(?:(?:<!--[\s\S]*?-->|{{stub}})\s*)*\s*\{\{Infobox Playgroup([\s\S]*?)\}\}([\s\S]*?)(\n\s*==|$)/i.exec(wikitext);
        const pageContentMatchRegexPlaintext = "Expects a page to start with any number of comments or '{{stub}}' (discarded), followed by an '{{Infobox Ferret ...}}', followed by some text (treated as summary), terminating at either the next '==' found or eof. (One match, case insensitive).";
        
        if (!pageContentMatch) {
            throw new Error("Failed regex parse: Infobox misformatted. " + pageContentMatchRegexPlaintext);
        }

        const infoboxContent = await this.parseInfoboxContent(pageContentMatch[1].trim());
        let image: string | null = null;

        if (infoboxContent["image"]) {
            try {
                image = z.url().parse(infoboxContent["image"]);
            } catch (e) {
                throw new Error("Playgroup infobox image field is not a valid URL: " + infoboxContent["image"]);
            }
        }

        let summary = DTS.processWikitext(pageContentMatch[2].trim(), false);

        if (summary.endsWith("<!--")) { // for when following section is commented out
            summary = summary.slice(0, -4).trim();
        }

        return { summary, image };
    }

    private async getPlaygroup(playgroupName: string, pageId: number, glossary: Record<string, string>, oldPlaygroupsData: OldPlaygroups): Promise<Playgroup> {
        const wikiText = await this.getPageWikitext(pageId);
        const { summary, image } = await this.parsePlaygroupWikitext(wikiText);
        const glossaryDesc = glossary[playgroupName];
        const pgOldInfoEntry = Object.entries(oldPlaygroupsData).find(([_, v]) => v.name === playgroupName);
        const pgOldInfo = pgOldInfoEntry ? pgOldInfoEntry[1] : null;

        if (!glossaryDesc) {
            if (!pgOldInfo) {
                console.warn(`No tooltip description found for playgroup "${playgroupName}" from either glossary or old playgroups data.`);
            } else {
                console.info(`No glossary description found for playgroup "${playgroupName}", using old playgroups data description.`);
            }
        }

        return {
            name: playgroupName,
            tooltip: glossaryDesc ? glossaryDesc : (pgOldInfo ? pgOldInfo.description : "A group of ferrets who play together. (missing tooltip)"),
            description: summary,
            image: image
        };
    }

    private async getGlossary(): Promise<Record<string, string>> {
        const glossaryWikitext = await this.getPageWikitext("Glossary");
        const glossaryTable = /=+\s*Terms\s*=+[^{=]*\{\|.*\s*(\|-[\s\S]*?)\s*(\|-[\s\S]*?)\s*\|\}/i.exec(glossaryWikitext);
        if (!glossaryTable) {
            throw new Error("Glossary table not found or misformatted.");
        }
        const headers = /^\|- *\n\! *term[^\n]*\n\! *definition[^\n]*\n/i.exec(glossaryTable[1]);
        if (!headers) {
            throw new Error("Glossary table headers misformatted. Expected 'Term' and 'Definition' as first words in each of the first two headers. Got: " + glossaryTable[1]);
        }
        const termRows = glossaryTable[2].split(/\|- *\n/).map(row => row.trim()).filter(row => row.length > 0);
        let glossary: Record<string, string> = {};
        for (const row of termRows) {
            const cells = row.split(/\n\|/).map(cell => cell.trim());
            if (cells.length < 2) {
                throw new Error("Glossary table row misformatted, expected at least two cells. Got: " + row);
            }
            const term = DTS.processWikitext(cells[0], false);
            const definition = DTS.processWikitext(cells[1], false);
            glossary[term] = definition;
        }
        return glossary;
    }

    //#region Public update functions
    async updateOutNowFerretsData(apiMinVersion: string): Promise<void> {
        console.log("Updating out now data");
    
        console.log(`Getting ${outnowJsonFilename}`);
        let outnowJson: VersionedApiJson = await this.getVersionedApiJson(`${publicRoot}/${outnowJsonFilename}`);
        console.log(`Updating ${outnowJsonFilename}`);
        const outnowData: OutNowFerretsData = {
            ferrets: [] //TODO: implement OutNow data population
        };

        for (const versionId in outnowJson) {
            if (versionId < apiMinVersion) {
                console.log(`Deleting old version ${versionId} from ${outnowJsonFilename}`);
                delete outnowJson[versionId];
            }
        }

        outnowJson[SCHEMA_VERSION_ID] = outnowData;
        await fs.writeFile(`${publicRoot}/${outnowJsonFilename}`, JSON.stringify(outnowJson, null, 2), "utf-8");
        console.log(`Updated ${outnowJsonFilename}`);

        console.log("Out now data update complete");
    }

    async updateFerretsData(apiMinVersion: string): Promise<void> {
        console.log("Updating ferret data");
    
        console.log("Fetching ferrets table");
        const ferretsTable = await this.getFerretsTable();
        console.log(`Fetched ${ferretsTable.length} ferret entries from table`);

        console.log("Loading image metadata file");
        const imageMeta = await this.getImageMetaFile();
        console.log(`Loaded image metadata for ${Object.keys(imageMeta.mugshots).length} mugshots`);

        console.log("Fetching glossary");
        const glossary = await this.getGlossary();
        console.log(`Fetched ${Object.keys(glossary).length} glossary entries`);

        console.log("Fetching old playgroup info");
        const oldPlaygroups = await this.loadOldPlaygroups();
        console.log(`Fetched ${Object.keys(oldPlaygroups).length} old playgroup entries`);

        console.log("Fetching playgroups page list from wiki category");
        const playgroupList = await this.getPlaygroupsList();
        console.log(`Found ${Object.keys(playgroupList).length} playgroups`);

        let ferrets: Ferret[] = [];
        let playgroups: Record<string, Playgroup> = {};
        for (const tableEntry of ferretsTable/*.filter(f => f.name == "Onion")*/) { //TEMP: only first ferret for testing
            console.log(`Processing ferret "${tableEntry.name}"`);
            let ferret: Ferret;
            try {
                ferret = await this.updateFerret(tableEntry, ferretsTable, imageMeta);
            } catch (e) {
                throw new Error(`Failed to process ferret "${tableEntry.name}": ${e}`);
            }
            ferrets.push(ferret);
            if (!playgroups[ferret.playgroup]) {
                console.log(`Processing playgroup "${ferret.playgroup}"`);
                let newPlaygroup: Playgroup;
                try {
                    const pageId = playgroupList[ferret.playgroup];
                    if (!pageId) {
                        throw new Error(`Wiki page not found in Playgroup wiki page category.`);
                    }
                    newPlaygroup = await this.getPlaygroup(ferret.playgroup, pageId, glossary, oldPlaygroups);
                } catch (e) {
                    throw new Error(`Failed to process playgroup "${ferret.playgroup}": ${e}`);
                }
                playgroups[ferret.playgroup] = newPlaygroup;
            }
        }
        
        console.log(`Getting ${ferretsJsonFilename}`);
        let ferretsJson: VersionedApiJson = await this.getVersionedApiJson(`${publicRoot}/${ferretsJsonFilename}`);

        console.log(`Getting ${ferretsMetaJsonFilename}`);
        let metaFile: ApiMeta = await this.getFerretsMetaFile();

        console.log(`Updating ${ferretsJsonFilename}`);
        const ferretsData: FerretsApiData = {
            ferrets: Object.fromEntries(ferrets.map(f => [f.name, f])),
            playgroups: playgroups
        }

        for (const versionId in ferretsJson) {
            if (versionId < apiMinVersion) {
                console.log(`Deleting old version ${versionId} from ${ferretsJsonFilename}`);
                delete ferretsJson[versionId];
            }
        }

        ferretsJson[SCHEMA_VERSION_ID] = ferretsData;
        await this.saveFerretsJson(ferretsJson);
        console.log(`Updated ${ferretsJsonFilename}`);
        
        console.log("Saving image metadata file");
        await this.saveImageMetaFile(imageMeta);
        console.log("Saved image metadata file");
        
        console.log(`Updating ${ferretsMetaJsonFilename}`);
        metaFile.apiVersion.current = SCHEMA_VERSION_ID;
        metaFile.lastUpdated = new Date().toISOString();
        await this.saveFerretsMetaFile(metaFile);
        console.log(`Updated ${ferretsMetaJsonFilename}`);

        console.log("Ferret data update complete");
    }
    //#endregion
}
