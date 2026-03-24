import { Ferret } from "@pirate-software/fs-data/build/ferrets/ferrets";
import { Playgroup } from "@pirate-software/fs-data/build/ferrets/playgroups";
import { SCHEMA_VERSION_ID, FerretsApiData, OutNowFerretsData, ApiMeta, apiMetaSchema } from "@pirate-software/fs-data/build/api";
import { BirthdayString, PartialDateString } from "@pirate-software/fs-data/build/types";
import { Logger } from "../logger";
import { DTSError, OldPlaygroups, VersionedApiJson } from "../util";
import { FerretTableEntry, WikiFetcher } from "./wiki";
import { FileHandler, ImageMetadataFile, publicRoot } from "./files";

// Consts
const mugshotPlaceholderFilename = "mugshot_placeholder.png";

export class DTS {
    apiBaseUrl: string;
    logger: Logger;
    wiki: WikiFetcher;
    files: FileHandler;
    
    constructor(logger: Logger, wikiFetcher: WikiFetcher, fileHandler: FileHandler, apiBaseUrl: string) {
        this.logger = logger;
        this.wiki = wikiFetcher;
        this.files = fileHandler;
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
                throw new DTSError(`Invalid date format: "${date}". Expected yyyy or yyyy-mm or yyyy-mm-dd.`);
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
            throw new DTSError(`Invalid year in date (< 2000) "${date}": "${y}"`);
        }
        if (m && !DTS._validateMonthDay(m, d)) {
            throw new DTSError(`Invalid month/day in date "${date}": month="${m}", day="${d}"`);
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
            throw new DTSError(`Invalid birthday date (missing month or day) "${date}": month="${m}", day="${d}"`);
        }
        if (!DTS._validateMonthDay(m, d)) {
            throw new DTSError(`Invalid month/day in birthday date "${date}": month="${m}", day="${d}"`);
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
    //#endregion

    private async updateFerret(tableEntry: FerretTableEntry, ferretsTable: FerretTableEntry[], imageMeta: ImageMetadataFile): Promise<Ferret> {
        const name = tableEntry.name;
        const wikiPage = DTS.nameAsWikiPageUrl(name);

        // Parse wiki page details
        let summary: string, lore: string, aliases: string[];
        try {
            ({ summary, lore, aliases } = await this.wiki.getFerretPage(wikiPage, (wikiPage: string) => ferretsTable.some(fe => DTS.nameAsWikiPageUrl(fe.name) === wikiPage)));
        } catch (e) {
            throw new DTSError(`Failed to parse wikitext (wiki page "${wikiPage}")`, e as Error);
        }

        // Parse table entry
        let birth: PartialDateString | null, birthday: BirthdayString | null, arrival: PartialDateString | null, valhalla: PartialDateString | null;
        try {
            birth = DTS.toDOBString(tableEntry["birth date"]);
        } catch (e) {
            throw new DTSError(`Failed to parse date of birth`, e as Error);
        }

        try {
            birthday = DTS.toBirthdayString(tableEntry["birth date"]);
        } catch (e) {
            throw new DTSError(`Failed to parse birthday`, e as Error);
        }

        try {
            arrival = DTS.toPartialDateString(tableEntry["arrival date"]);
        } catch (e) {
            throw new DTSError(`Failed to parse arrival date`, e as Error);
        }

        try {
            valhalla = DTS.toPartialDateString(tableEntry["valhalla date"]);
        } catch (e) {
            throw new DTSError(`Failed to parse valhalla date`, e as Error);
        }

        // fill missing summaries
        if (!summary) {
            summary = `${name} ${valhalla ? "was" : "is"} a rescue ferret of Snails House.`
        }

        // Get mugshot
        let mugshotUrl: string;
        mugshotUrl = await this.updateMugshot(name, wikiPage, imageMeta);

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

    private async updateMugshot(name: string, wikiPage: string, imageMeta: ImageMetadataFile): Promise<string> {
        let mugshotUrl: string;
        const ferretSlug = DTS.nameAsSlug(name);
        let mugshotWikiUrl: string | null = null;
        let mugshotTimestamp: string | null = null;
        const mugshotData = await this.wiki.getMugshotUrl(name);
        if (mugshotData) {
            mugshotWikiUrl = mugshotData.url;
            mugshotTimestamp = mugshotData.timestamp;
        }
        if (!mugshotWikiUrl) {
            this.logger.warn(`Mugshot not found for "${name}" (wiki page "${wikiPage}")`);
            mugshotUrl = this.apiBaseUrl + mugshotPlaceholderFilename;
        } else {
            if (!imageMeta.mugshots[ferretSlug] || imageMeta.mugshots[ferretSlug].lastUpdateTimestamp !== mugshotTimestamp) {
                this.logger.info(`Updating mugshot for "${name}"`);
                const mugshotPath = await this.files.saveMugshot(ferretSlug, mugshotWikiUrl);
                imageMeta.mugshots[ferretSlug] = {
                    path: mugshotPath,
                    lastUpdateTimestamp: mugshotTimestamp ?? new Date(2000, 0, 1).toISOString()
                };
            }
            if (!imageMeta.mugshots[ferretSlug].path.startsWith(publicRoot)) {
                throw new DTSError(`Mugshot path "${imageMeta.mugshots[ferretSlug].path}" is not in public root "${publicRoot}"`);
            }
            mugshotUrl = this.apiBaseUrl + imageMeta.mugshots[ferretSlug].path.substring(publicRoot.length + 1);
        }
        return mugshotUrl;
    }

    private async getPlaygroup(playgroupName: string, pageId: number, glossary: Record<string, string>, oldPlaygroupsData: OldPlaygroups): Promise<Playgroup> {
        const { tooltip, summary, image: wikiImageUrl } = await this.wiki.getPlaygroup(pageId);
        const glossaryDesc = glossary[playgroupName];
        const pgOldInfoEntry = Object.entries(oldPlaygroupsData).find(([_, v]) => v.name === playgroupName);
        const pgOldInfo = pgOldInfoEntry ? pgOldInfoEntry[1] : null;

        if (!tooltip) {
            this.logger.warn(`Tooltip missing for playgroup "${playgroupName}". Using glossary -> old info -> placeholder fallback chain.`);
        }

        if (wikiImageUrl) {
            this.logger.warn("Playgroup images not implemented.");
        }

        const image = this.apiBaseUrl + mugshotPlaceholderFilename;

        return {
            name: playgroupName,
            wikipage: DTS.nameAsWikiPageUrl(playgroupName),
            tooltip: tooltip ?? glossaryDesc ?? (pgOldInfo ? pgOldInfo.description : "A group of ferrets who have playtimes together. (missing tooltip)"),
            description: summary,
            image: image
        };
    }

    private async fixOldData(newData: FerretsApiData, versionId: string, oldData: any): Promise<any> {
        this.logger.info(`Checking for needed fixes to old data with version id ${versionId}`);
        if (versionId === "v1") {
            this.logger.info("Applying v1 Media fixes");
            // for each item in the data, set data[item][mugshot][src] to newData.ferrets[item].mugshot (if exists)
            for (const item in oldData) {
                if (oldData[item]["mugshot"] && oldData[item]["mugshot"]["src"] && newData.ferrets[item] && newData.ferrets[item].mugshot) {
                    oldData[item].mugshot.src = newData.ferrets[item].mugshot;
                }
            }

            // this.logger.info("Applying v1 valid playgroups");
            // const validPlaygroups = ["bepeepo",
            //     "fs",
            //     "genpop",
            //     "kyosai",
            //     "k",
            //     "luno",
            //     "m",
            //     "ocarinaoftube",
            //     "oldies",
            //     "pms",
            //     "rb",
            //     "solo",
            //     "valhalla",
            //     "vons"
            // ];

            // for (const item in oldData) {
            //     if (oldData[item]["playgroup"] && !validPlaygroups.includes(oldData[item].playgroup)) {
            //         this.logger.info(`Fixing invalid playgroup "${oldData[item].playgroup}" for ferret "${item}"`);
            //         oldData[item].playgroup = "solo";
            //     }
            // }
        } else {
            this.logger.info(`No fixes needed for old data with version id ${versionId}`);
        }
        return oldData;
    }

    //#region Public update functions
    async updateOutNowFerretsData(apiMinVersion: string): Promise<void> {
        this.logger.info("Updating out now data");
    
        this.logger.debug(`Getting out now json`);
        let outnowJson: VersionedApiJson = await this.files.getOutNowJson();
        this.logger.debug(`Updating out now json`);
        const outnowData: OutNowFerretsData = {
            ferrets: [] //TODO: implement OutNow data population
        };

        for (const versionId in outnowJson) {
            if (versionId < apiMinVersion) {
                this.logger.info(`Deleting old version ${versionId} from out now json`);
                delete outnowJson[versionId];
            }
        }

        outnowJson[SCHEMA_VERSION_ID] = outnowData;
        await this.files.writeOutNowJson(outnowJson);
        this.logger.debug(`Updated out now json with version ${SCHEMA_VERSION_ID}`);

        this.logger.info("Out now data update complete");
    }

    async updateFerretsData(apiMinVersion: string): Promise<void> {
        this.logger.info("Updating ferret data");
    
        this.logger.debug("Fetching ferrets table");
        const {success: ferretsTable, duplicates: duplicateNames, failed: failedNames} = await this.wiki.getFerretsTable();
        if (duplicateNames.length > 0) {
            this.logger.warn(`Duplicate ferret names found in ferrets cargotable. At least one was successfully processed for each one though: ${duplicateNames.join(", ")}`);
        }
        if (Object.keys(failedNames).length > 0) {
            throw new DTSError(`Failed to parse the following ferret table entries: ${Object.entries(failedNames).map(([name, error]) => `\n- ${name}: ${error.message}`).join("")}`);
        }
        this.logger.debug(`Fetched ${ferretsTable.length} ferret entries from table`);

        this.logger.debug("Loading image metadata file");
        const imageMeta = await this.files.getImageMetaFile();
        this.logger.debug(`Loaded image metadata for ${Object.keys(imageMeta.mugshots).length} mugshots`);

        this.logger.debug("Fetching glossary");
        let glossary: Record<string, string>;
        try {
            glossary = await this.wiki.getGlossary();
        } catch (e) {
            this.logger.warn("Failed to fetch glossary from wiki, proceeding with empty glossary. Generated error:", e);
            glossary = {};
        }
        this.logger.debug(`Fetched ${Object.keys(glossary).length} glossary entries`);

        this.logger.debug("Fetching old playgroup info");
        const oldPlaygroups = await this.files.loadOldPlaygroups();
        this.logger.debug(`Fetched ${Object.keys(oldPlaygroups).length} old playgroup entries`);

        this.logger.debug("Fetching playgroups page list from wiki category");
        const playgroupList = await this.wiki.getPlaygroupsList();
        this.logger.debug(`Found ${Object.keys(playgroupList).length} playgroups`);

        let ferrets: Ferret[] = [];
        let playgroups: Record<string, Playgroup> = {};
        for (const tableEntry of ferretsTable/*.filter(f => f.name == "Milo")*/) { //TEMP: only first ferret for testing
            this.logger.debug(`Processing ferret "${tableEntry.name}"`);
            
            let ferret: Ferret;
            try {
                ferret = await this.updateFerret(tableEntry, ferretsTable, imageMeta);
            } catch (e) {
                throw new DTSError(`Failed to process ferret "${tableEntry.name}"`, e as Error);
            }
            ferrets.push(ferret);
            if (!playgroups[ferret.playgroup]) {
                this.logger.debug(`Processing playgroup "${ferret.playgroup}"`);
                let newPlaygroup: Playgroup;
                try {
                    const pageId = playgroupList[ferret.playgroup];
                    if (!pageId) {
                        throw new DTSError(`Wiki page id for playgroup ${ferret.playgroup} not found in Playgroup wiki page category via query.`);
                    }
                    newPlaygroup = await this.getPlaygroup(ferret.playgroup, pageId, glossary, oldPlaygroups);
                } catch (e) {
                    throw new DTSError(`Failed to process playgroup "${ferret.playgroup}", found on ferret "${ferret.name}"`, e as Error);
                }
                playgroups[ferret.playgroup] = newPlaygroup;
            }
        }

        this.logger.debug("Saving image metadata file");
        await this.files.saveImageMetaFile(imageMeta);
        this.logger.debug("Saved image metadata file");
        
        this.logger.debug(`Getting ferrets json`);
        let ferretsJson: VersionedApiJson = await this.files.getFerretsJson();

        this.logger.debug(`Getting ferrets meta file`);
        let metaFile: ApiMeta = await this.files.getFerretsMetaFile();

        this.logger.debug(`Updating ferrets json with version ${SCHEMA_VERSION_ID}`);
        const ferretsData: FerretsApiData = {
            ferrets: Object.fromEntries(ferrets.map(f => [DTS.nameAsSlug(f.name), f])),
            playgroups: playgroups
        }

        for (const versionId in ferretsJson) {
            if (versionId < apiMinVersion) {
                this.logger.info(`Deleting unsupported version ${versionId} from ferrets json`);
                delete ferretsJson[versionId];
            } else if (versionId !== SCHEMA_VERSION_ID) {
                ferretsJson[versionId] = await this.fixOldData(ferretsData, versionId, ferretsJson[versionId]);
            }
        }

        ferretsJson[SCHEMA_VERSION_ID] = ferretsData;
        await this.files.saveFerretsJson(ferretsJson);
        this.logger.debug(`Updated ferrets json with version ${SCHEMA_VERSION_ID}`);
        
        this.logger.debug(`Updating ferrets meta file`);
        metaFile.apiVersion.current = SCHEMA_VERSION_ID;
        metaFile.apiVersion.min = apiMinVersion;
        metaFile.lastUpdated = new Date().toISOString();
        await this.files.saveFerretsMetaFile(metaFile);
        this.logger.debug(`Updated ferrets meta file`);

        this.logger.info("Ferret data update complete");
    }
    //#endregion
}
