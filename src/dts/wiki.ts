import { z } from "zod";
import { Logger } from "../logger";
import { asciiSchema, dateStringSchema, DTSError } from "../util";
import { VersionedApiJson } from "../util";

//#region Query Schemas
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

type SquareBracketNest<T> = { open: number; close: number; children: SquareBracketNest<T>[] };
interface SquareBracketNestNode extends SquareBracketNest<SquareBracketNestNode> {}

export const ferretTableEntrySchema = z.object({
    name: asciiSchema,
    gender: z.enum(["Male", "Female"]),
    "arrival date": dateStringSchema.or(z.string().length(0)),
    "birth date": dateStringSchema.or(z.string().length(0)),
    "valhalla date": dateStringSchema.or(z.string().length(0)),
    playgroup: asciiSchema
});
export type FerretTableEntry = z.infer<typeof ferretTableEntrySchema>;


export class WikiFetcher {
    wikiApiBaseUrl: string;
    wikiPageRoot: string;
    logger: Logger;
    
    constructor(logger: Logger, wikiApiBaseUrl: string, wikiPageRoot: string) {
        this.logger = logger;
        this.wikiApiBaseUrl = wikiApiBaseUrl;
        this.wikiPageRoot = wikiPageRoot;
        if (!this.wikiPageRoot.endsWith("/")) {
            this.wikiPageRoot += "/";
        }
    }

    //#region Static utils
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
                    throw new DTSError(`Unmatched closing brackets at position ${i} in string "${s}"`);
                }
                const node = stack.pop()!;
                node.close = i + 1;
                i++; // skip second ]
            }
        }
        if (stack.length > 0) {
            throw new DTSError(`Unmatched opening brackets at position ${stack[0].open} in string "${s}"`);
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
        const nests = this._getDoubleSquareBracketNests(subbed);
        
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
                        out += linkTarget === linkText ? `[[${linkTarget}]]` : `[[${linkTarget}|${linkText}]]`;
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
        let text: string = "(no response read)";
        try {
            text = await res.text();
            const json = JSON.parse(text);
            return json;
        } catch (e) {
            this.logger.error("Error parsing JSON from wiki API response");
            this.logger.error("Response text:", text);
            this.logger.error(e);
            throw e;
        }
    }

    private async getWikiAPIParsed<T>(params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
        const res = await this.getWikiAPI(params);
        let parsed: T;
        try {
            parsed = schema.parse(res);
        } catch (e) {
            this.logger.error(`Failed to parse Wiki API response from params ${JSON.stringify(params)}: ${e}`);
            throw e;
        }
        return parsed;
    }

    private async parseInfoboxContent(infoboxContent: string): Promise<Record<string, string>> {
        const content = Array.from(infoboxContent.matchAll(/^\|[ \t]*(\w+)[ \t]*=[ \t]*(.*)$/gim));

        if (!content) {
            throw new DTSError("Infobox has no content: " + infoboxContent);
        }

        if (content.length !== infoboxContent.split("\n").length) {
            throw new DTSError("Infobox content has uneven number of fields/values. Likely bad regex: " + infoboxContent);
        }

        const fields: Record<string, string> = {};
        for (const matches of content) {
            const field = matches[1];
            const value = matches[2];
            fields[field] = value;
        }

        return fields;
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

    public async getFerretPage(wikiPage: string, isLinkableFerret: (wikiPage: string) => boolean): Promise<{summary: string, lore: string, aliases: string[]}> {
        const wikitext = await this.getPageWikitext(wikiPage);
        const pageContentMatch = /^\s*(?:(?:<!--[\s\S]*?-->|{{stub}})\s*)*\s*\{\{Infobox Ferret([\s\S]*?)\}\}([\s\S]*)\n\s*==\s*Lore\s*==([\s\S]*?)(\n\s*==|$)/i.exec(wikitext);
        const pageContentMatchRegexPlaintext = "Expects a page to start with any number of comments or '{{stub}}' (discarded), followed by an '{{Infobox Ferret ...}}', followed by some text (treated as summary), followed by a '== Lore ==' and some text, terminating at either the next '==' found or eof. (One match, case insensitive).";
        
        if (!pageContentMatch) {
            throw new DTSError("Failed regex parse: Infobox, summary, or lore section header misformatted. " + pageContentMatchRegexPlaintext);
        }
        
        const infoboxContent = await this.parseInfoboxContent(pageContentMatch[1].trim());
        
        let aliases: string[] = [];
        for (const field in infoboxContent) {
            if (/^(nickname|shayename)s?$/i.test(field)) {
                aliases.push(...infoboxContent[field].split(/;|,|<br>/).map(s => s.trim()).filter(s => s.length > 0));
            }
        }

        let summary = WikiFetcher.processWikitext(pageContentMatch[2].trim(), true, isLinkableFerret);
        if (!summary || summary.startsWith("Category:Ferrets lacking intro")) { // missing summary
            summary = "";
        }

        const lore = WikiFetcher.processWikitext(pageContentMatch[3].trim(), true, isLinkableFerret);

        return { summary, lore, aliases };
    }

    public async getPlaygroup(pageId: number): Promise<{tooltip: string | null, summary: string, image: string | null}> {
        const wikitext = await this.getPageWikitext(pageId);
        const pageContentMatch = /^\s*(?:(?:<!--[\s\S]*?-->|{{stub}})\s*)*\s*\{\{Infobox Playgroup([\s\S]*?)\}\}([\s\S]*?)(\n\s*==|$)/i.exec(wikitext);
        const pageContentMatchRegexPlaintext = "Expects a page to start with any number of comments or '{{stub}}' (discarded), followed by an '{{Infobox Ferret ...}}', followed by some text (treated as summary), terminating at either the next '==' found or eof. (One match, case insensitive).";
        
        if (!pageContentMatch) {
            throw new DTSError("Failed regex parse: Infobox misformatted. " + pageContentMatchRegexPlaintext);
        }

        const infoboxContent = await this.parseInfoboxContent(pageContentMatch[1].trim());
        let image: string | null = null;

        if (infoboxContent["image"]) {
            try {
                image = z.url().parse(infoboxContent["image"]);
            } catch (e) {
                throw new DTSError("Playgroup infobox image field is not a valid URL: " + infoboxContent["image"]);
            }
        }

        let tooltip: string | null = infoboxContent["short_intro"] ? infoboxContent["short_intro"] : null;

        let summary = WikiFetcher.processWikitext(pageContentMatch[2].trim(), false);

        if (summary.endsWith("<!--")) { // for when following section is commented out
            summary = summary.slice(0, -4).trim();
        }

        return { tooltip, summary, image };
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

    public async getFerretsTable(): Promise<{ success: FerretTableEntry[], duplicates: string[], failed: Record<string, Error> }> {
        const rows = await this.getCargoTable("Ferrets", ["name", "gender", "arrival_date", "birth_date", "valhalla_date", "playgroup"]);
        // ensure rows are unique by name
        const processedNames = new Set<string>();
        const duplicateNames = new Set<string>();
        const failedNames: Record<string, Error> = {};
        let out: FerretTableEntry[] = [];
        for (const row of rows) {
            if (processedNames.has(row.name)) { // if processed successfully before, mark as duplicate and ignore
                duplicateNames.add(row.name);
                continue;
            }

            let parsed: FerretTableEntry;

            try {
                parsed = ferretTableEntrySchema.parse(row);
            } catch (e) {
                if (!failedNames[row.name]) {
                    failedNames[row.name] = e as Error;
                }
                continue;
            }

            // Success
            if (failedNames[row.name]) { // if failed, now just mark as duplicate
                delete failedNames[row.name];
                duplicateNames.add(row.name);
            }
            out.push(parsed);
            processedNames.add(row.name);
        }

        return { success: out, duplicates: Array.from(duplicateNames), failed: failedNames };
    }

    public async getMugshotUrl(ferretName: string): Promise<{url: string, timestamp: string} | null> {
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

    public async getPlaygroupsList(): Promise<Record<string, number>> {
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

    public async getGlossary(): Promise<Record<string, string>> {
        const glossaryWikitext = await this.getPageWikitext("Glossary");
        const glossaryTable = /=+\s*Terms\s*=+[^{=]*\{\|.*\s*(\|-[\s\S]*?)\s*(\|-[\s\S]*?)\s*\|\}/i.exec(glossaryWikitext);
        if (!glossaryTable) {
            throw new DTSError("Glossary table not found or misformatted.");
        }
        const headers = /^\|- *\n\! *term[^\n]*\n\! *definition[^\n]*\n/i.exec(glossaryTable[1]);
        if (!headers) {
            throw new DTSError("Glossary table headers misformatted. Expected 'Term' and 'Definition' as first words in each of the first two headers. Got: " + glossaryTable[1]);
        }
        const termRows = glossaryTable[2].split(/\|- *\n/).map(row => row.trim()).filter(row => row.length > 0);
        let glossary: Record<string, string> = {};
        for (const row of termRows) {
            const cells = Array.from(row.matchAll(/^[ \t]*\|(.*)$/gm)).map(match => match[1].trim()) || [];
            if (cells.length < 2) {
                throw new DTSError("Glossary table row misformatted, expected at least two cells. Got " + cells.length);
            }
            const terms = WikiFetcher.processWikitext(cells[0], false);
            const definition = WikiFetcher.processWikitext(cells[1], false);
            for (const term of terms.split("/").map(t => t.trim()).filter(t => t.length > 0)) {
                glossary[term] = definition;
            }
        }
        return glossary;
    }

    
    //#endregion
}
