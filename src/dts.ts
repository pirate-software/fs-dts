import { ferretSchema } from "@pirate-software/fs-data/build/ferrets/core";
import { z } from "zod";
import fs from "fs/promises";

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

const apiResMugshotUrlSchema = z.object({
    query: z.object({
        pages: z.record(z.string(), z.object({
            imageinfo: z.array(z.object({
                url: z.url()
            })).optional()
        }))
    })
});

const ferretTableEntry = z.object({
    name: asciiSchema,
    gender: z.enum(["Male", "Female"]),
    "arrival date": dateStringSchema.or(z.string().length(0)),
    "birth date": dateStringSchema.or(z.string().length(0)),
    "valhalla date": dateStringSchema.or(z.string().length(0)),
    playgroup: asciiSchema
});

const publicRoot = "./public";

export class DTS {
    wikiBaseUrl: string;
    apiBaseUrl: string;
    
    constructor(wikiBaseUrl: string, apiBaseUrl: string) {
        this.wikiBaseUrl = wikiBaseUrl;
        this.apiBaseUrl = apiBaseUrl;
    }

    static nameAsSlug(name: string): string {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    }

    static nameAsChatCommands(name: string): string[] {
        let commands: string[] = [];
        let cleanName = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
        commands.push(`show ${cleanName}`);
        if (cleanName.endsWith("s")) {
            commands.push(`show ${cleanName.slice(0, -1)}`);
        }
        return commands;
    }

    static nameAsWikiPageUrl(name: string): string {
        return name.split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join("_");
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

    private async getFerretsTable(): Promise<z.infer<typeof ferretTableEntry>[]> {
        const rows = await this.getCargoTable("Ferrets", ["name", "gender", "arrival_date", "birth_date", "valhalla_date", "playgroup"]);
        return rows.map(row => ferretTableEntry.parse(row));
    }

    private async getMugshotUrl(ferretName: string): Promise<string | null> {
        const params = {
            "action": "query",
            "titles": `File:${ferretName}_Mugshot.png`,
            "prop": "imageinfo",
            "iiprop": "url",
            "format": "json"
        }
        const res = await this.getWikiAPI(params);
        const parsed = apiResMugshotUrlSchema.parse(res);
        const pages = parsed.query.pages;
        for (const pageId in pages) {
            const page = pages[pageId];
            if (page.imageinfo && page.imageinfo.length > 0) {
                return page.imageinfo[0].url;
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

    async updateData(): Promise<void> {
        console.log("Updating data");
    
        console.log("Fetching")
        let beansUrl = await this.getMugshotUrl("Beans");
        console.log(beansUrl);
        await this.saveMugshot("beans", beansUrl!);
        console.log("Saved Beans mugshot");
        // let ferrets = (await this.getFerretsTable());
        // await this.getPageWikitext("Beans");

        // https://github.com/pirate-software/fs-data/blob/main/wikiscraper/scrape.py#L19
    }
}
