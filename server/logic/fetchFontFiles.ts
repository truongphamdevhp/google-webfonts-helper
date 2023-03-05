import * as Bluebird from "bluebird";
import * as fs from "fs";
import * as JSZip from "jszip";
import * as _ from "lodash";
import * as path from "path";
import { Readable } from "stream";
import { finished } from "stream/promises";
import { config } from "../config";
import { asyncRetry } from "../utils/asyncRetry";
import { IVariantItem } from "./fetchFontURLs";

const RETRIES = 5;

export interface ISubsetFontArchive {
  zippedFileName: string;
  paths: IFontFilePath[];
}

export interface IFontFilePath {
  variant: string;
  format: string;
  path: string;
}

export async function fetchFontFiles(
  fontID: string,
  fontVersion: string,
  subsets: string[],
  variants: IVariantItem[]
): Promise<ISubsetFontArchive> {
  const subsetFontArchive: ISubsetFontArchive = {
    zippedFileName: path.join(config.CACHE_DIR, `/${fontID}-${fontVersion}-${_.first(variants)?.subsets.join("_")}.zip`),
    paths: [],
  };

  const archive = new JSZip();

  const streams: (Readable | fs.WriteStream)[] = _.compact(
    _.flatten(
      await Bluebird.map(variants, async (variant) => {
        return await Bluebird.map(variant.urls, async (variantUrl) => {
          const filename = path.join(config.CACHE_DIR, `/${fontID}-${fontVersion}-${subsets.join("_")}-${variant.id}.${variantUrl.format}`);

          // download the file for type (filename now known)
          let stream: Readable;
          try {
            stream = await fetchFontFileStream(variantUrl.url, filename, variantUrl.format);
            archive.file(path.basename(filename), stream);
          } catch (e) {
            // if a specific format does not work, silently discard it.
            console.error("fetchFontFiles discarding", fontID, variant.subsets.join("_"), variantUrl.url, variantUrl.format, filename, e);
            return null;
          }

          subsetFontArchive.paths.push({
            variant: variant.id, // variants and format are used to filter them out later!
            format: variantUrl.format,
            path: filename,
          });

          return stream;
        });
      })
    )
  );

  const target = fs.createWriteStream(subsetFontArchive.zippedFileName);
  streams.push(target);

  try {
    await finished(
      archive
        .generateNodeStream({
          compression: "DEFLATE",
        })
        .pipe(target)
    );
  } catch (e) {
    // ensure all fs streams into the archive and the actual zip file are destroyed
    _.each(streams, (stream) => {
      stream.destroy();
    });
    throw e;
  }

  return subsetFontArchive;
}

async function fetchFontFileStream(url: string, dest: string, format: string): Promise<Readable> {
  return asyncRetry<Readable>(
    async () => {
      const response = await fetch(url);
      const contentType = response.headers.get("content-type");

      if (response.status !== 200) {
        throw new Error(`${url} fetchFontFileStream request failed. status code: ${response.status} ${response.statusText}`);
      }

      if (_.isNil(contentType) || _.isEmpty(contentType) || contentType.indexOf(format) === -1) {
        throw new Error(`${url} fetchFontFileStream request failed. expected ${format} to be in content-type header: ${contentType}`);
      }

      // TODO typing mismatch ReadableStream<any> vs ReadableStream<Uint8Array>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Readable.fromWeb(<any>response.body);
    },
    { retries: RETRIES }
  );
}
