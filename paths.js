"use strict";

/**
 * Where each database lives. The image and feed databases sit beside the
 * crawl database, so pointing QUEST_DB_PATH somewhere else (as the tests do)
 * moves all three together. The PHP sites read data/<name>.sqlite.
 */

const path = require("node:path");

function dataPaths() {
  const main = process.env.QUEST_DB_PATH || path.join(process.env.QUEST_DATA_DIR || path.join(__dirname, "data"), "quest.sqlite");
  const dir = path.dirname(main);
  return {
    main,
    images: process.env.QUEST_IMAGES_DB_PATH || path.join(dir, "images.sqlite"),
    feeds: process.env.QUEST_FEEDS_DB_PATH || path.join(dir, "feeds.sqlite"),
    exyra: process.env.QUEST_EXYRA_DB_PATH || path.join(dir, "exyra.sqlite"),
  };
}

module.exports = { dataPaths };
