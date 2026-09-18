import { IndexedDbCountingRepository } from "../adapters/storage/IndexedDbCountingRepository";
import { ImportService } from "./services/ImportService";
import { CountSessionService } from "./services/CountSessionService";
import { CountingService } from "./services/CountingService";

/**
 * Eenvoudige, handmatige dependency-"container" voor v0.1: één gedeelde
 * repository-instantie (vandaag IndexedDB), en de services die daarop
 * bouwen. UI-schermen importeren enkel deze services, nooit Dexie of xlsx
 * rechtstreeks (behalve de importpagina, die een StockSource-adapter
 * aanmaakt — zie ui/pages/ImportPage.tsx).
 *
 * Wanneer eBuddy-adapters er zijn, verandert enkel deze file (en de
 * importpagina): repository wordt bv. `new EBuddyCountingRepository(...)`.
 */
const repository = new IndexedDbCountingRepository();

export const importService = new ImportService(repository);
export const countSessionService = new CountSessionService(repository);
export const countingService = new CountingService(repository);
export const countingRepository = repository;
