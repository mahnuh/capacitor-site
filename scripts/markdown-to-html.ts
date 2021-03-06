import marked from 'marked';
import glob from 'glob';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import url from 'url';
import { rimraf, mkdirp } from '@stencil/utils';
import { collectHeadingMetadata, changeCodeCreation, localizeMarkdownLink } from './markdown-renderer';
import frontMatter from 'front-matter';
import fetch from 'node-fetch';
import { SiteStructureItem, MarkdownContent } from '../src/global/definitions';
import { SITE_FILES } from './common';

require('dotenv').config();

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const globAsync = promisify(glob);

(async function() {
  for (const SITE_FILE of SITE_FILES) {
    const SOURCE_DIR = SITE_FILE.source;
    const STRUCTURE_FILE = SITE_FILE.structure;
    const ASSET_DIR = `src/${SITE_FILE.assets}`;

    const siteStructure = await readFile(STRUCTURE_FILE, { encoding: 'utf8' });
    const siteStructureJson: SiteStructureItem[] = JSON.parse(siteStructure);
    console.log(`running glob: ${SOURCE_DIR}/**/*.md`);
    const files = await globAsync(`${SOURCE_DIR}/**/*.md`, {});

    await rimraf(ASSET_DIR);

    const filePromises = files.map(async (filePath) => {
      if (filePath === `${SOURCE_DIR}/README.md`) {
        return Promise.resolve();
      }
      let htmlContents = '';
      let markdownMetadata: MarkdownContent = {};
      const jsonFileName = path.relative(SOURCE_DIR, filePath);
      const destinationFileName = path.join(
        ASSET_DIR,
        path.dirname(jsonFileName),
        path.basename(jsonFileName, '.md') + '.json'
      );
      markdownMetadata.headings = [];

      const markdownContents = await readFile(filePath, { encoding: 'utf8' });

      try {
        let parsedMarkdown = frontMatter(markdownContents);
        parsedMarkdown = await getGithubData(filePath, parsedMarkdown);

        const renderer = new marked.Renderer();

        collectHeadingMetadata(renderer, markdownMetadata);
        changeCodeCreation(renderer);
        localizeMarkdownLink(renderer, destinationFileName.replace('src',''), siteStructureJson);
        htmlContents = marked(parsedMarkdown.body, {
          renderer,
          headerIds: true
        });

        await mkdirp(path.join(
          ASSET_DIR,
          path.dirname(jsonFileName)
        ));

        await writeFile(destinationFileName, JSON.stringify({
          ...parsedMarkdown.attributes as any,
          ...markdownMetadata,
          srcPath: filePath,
          content: htmlContents
        }), {
          encoding: 'utf8'
        });

      } catch (e) {
        console.error(filePath);
        throw e;
      }
    });

    await Promise.all(filePromises);

    console.log(`successfully converted ${filePromises.length} files`);
  }
})();


async function getGithubData(filePath: string, parsedMarkdown: any) {
  const since = new Date('2018-06-01').toISOString();

  try {
    const request = await fetch(url.format({
      protocol: 'https',
      hostname: 'api.github.com',
      pathname: 'repos/ionic-team/capacitor-site/commits',
      query: {
        access_token: process.env.GITHUB_TOKEN,
        since: since,
        path: filePath
      }
    }));

    if (request.status === 403) {
      console.warn(`Ignoring commit history for ${filePath} due to GH API limit. To resolve, add the GITHUB_TOKEN envar.`);
      return parsedMarkdown;
    }

    const commits = await request.json();
    const contributors = Array.from(new Set(commits.map(commit => commit.author.login)));
    const lastUpdated = commits.length ? commits[0].commit.author.date : since;

    const attributes = parsedMarkdown.attributes = parsedMarkdown.attributes || {};
    attributes.lastUpdated = lastUpdated;

    attributes.contributors = attributes.contributors || [];

    contributors.forEach(contributor => {
      if (!attributes.contributors.includes(contributor)) {
        attributes.contributors.push(contributor);
      }
    });
  } catch (e) {
    console.log(e);
  }

  return parsedMarkdown;
}
