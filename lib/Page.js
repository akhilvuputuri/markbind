const cheerio = require('cheerio');
const fm = require('fastmatter');
const fs = require('fs-extra-promise');
const htmlBeautify = require('js-beautify').html;
const nunjucks = require('nunjucks');
const path = require('path');
const pathIsInside = require('path-is-inside');
const Promise = require('bluebird');

const FsUtil = require('./util/fsUtil');
const logger = require('./util/logger');
const MarkBind = require('./markbind/lib/parser');
const md = require('./markbind/lib/markdown-it');

const FOOTERS_FOLDER_PATH = '_markbind/footers';
const NAVIGATION_FOLDER_PATH = '_markbind/navigation';

const FLEX_BODY_DIV_ID = 'flex-body';
const FLEX_DIV_HTML = '<div id="flex-div"></div>';
const FLEX_DIV_ID = 'flex-div';
const FRONT_MATTER_FENCE = '---';
const PAGE_CONTENT_ID = 'page-content';
const SITE_NAV_ID = 'site-nav';
const TITLE_PREFIX_SEPARATOR = ' - ';

const DROPDOWN_BUTTON_ICON_HTML = '<i class="dropdown-btn-icon">\n'
  + '<span class="glyphicon glyphicon-menu-down" aria-hidden="true"></span>\n'
  + '</i>';
const SITE_NAV_BUTTON_HTML = '<div id="site-nav-btn-wrap">\n'
  + '<div id="site-nav-btn">\n'
  + '<div class="menu-top-bar"></div>\n'
  + '<div class="menu-middle-bar"></div>\n'
  + '<div class="menu-bottom-bar"></div>\n'
  + '</div>\n'
  + '</div>';

cheerio.prototype.options.xmlMode = true; // Enable xml mode for self-closing tag
cheerio.prototype.options.decodeEntities = false; // Don't escape HTML entities

function Page(pageConfig) {
  this.asset = pageConfig.asset;
  this.baseUrl = pageConfig.baseUrl;
  this.baseUrlMap = pageConfig.baseUrlMap;
  this.content = pageConfig.content || '';
  this.faviconUrl = pageConfig.faviconUrl;
  this.rootPath = pageConfig.rootPath;
  this.searchable = pageConfig.searchable;
  this.src = pageConfig.src;
  this.template = pageConfig.pageTemplate;
  this.title = pageConfig.title || '';
  this.titlePrefix = pageConfig.titlePrefix;
  this.userDefinedVariablesMap = pageConfig.userDefinedVariablesMap;

  // the source file for rendering this page
  this.sourcePath = pageConfig.sourcePath;
  // the temp path for writing intermediate result
  this.tempPath = pageConfig.tempPath;
  // the output path of this page
  this.resultPath = pageConfig.resultPath;

  this.frontMatter = {};
  this.headings = {};
  this.includedFiles = {};
  this.headingIndexingLevel = pageConfig.headingIndexingLevel;
}

/**
 * Util Methods
 */

function calculateNewBaseUrl(filePath, root, lookUp) {
  function calculate(file, result) {
    if (file === root || !pathIsInside(file, root)) {
      return undefined;
    }
    const parent = path.dirname(file);
    if (lookUp[parent] && result.length === 1) {
      return path.relative(root, result[0]);
    } else if (lookUp[parent]) {
      return calculate(parent, [parent]);
    }
    return calculate(parent, result);
  }

  return calculate(filePath, []);
}

function formatFooter(pageData) {
  const $ = cheerio.load(pageData);
  const footers = $('footer');
  if (footers.length === 0) {
    return pageData;
  }
  // Remove preceding footers
  footers.slice(0, -1).remove(); // footers.not(':last').remove();
  // Unwrap last footer
  const lastFooter = footers.last();
  const lastFooterParents = lastFooter.parents();
  if (lastFooterParents.length) {
    const lastFooterOutermostParent = lastFooterParents.last();
    lastFooterOutermostParent.after(lastFooter);
  }
  // Insert flex div before last footer
  if (lastFooter.prev().attr('id') !== FLEX_DIV_ID) {
    $(lastFooter).before(FLEX_DIV_HTML);
  }
  return $.html();
}

function formatSiteNav(renderedSiteNav) {
  const $ = cheerio.load(renderedSiteNav);
  const listItems = $.root().find('ul').first().children();
  if (listItems.length === 0) {
    return renderedSiteNav;
  }
  // Tidy up the style of the unordered list <ul>
  listItems.parent().attr('style', 'list-style-type: none; margin-left:-1em');

  listItems.each(function () {
    // Tidy up the style of each list item
    $(this).attr('style', 'margin-top: 10px');
    // Do not render dropdown menu for list items with <a> tag
    if ($(this).children('a').length) {
      const nestedList = $(this).children('ul').first();
      if (nestedList.length) {
        // Double wrap to counter replaceWith removing <li>
        nestedList.parent().wrap('<li style="margin-top:10px"></li>');
        // Recursively format nested lists without dropdown wrapper
        nestedList.parent().replaceWith(formatSiteNav(nestedList.parent().html()));
      }
    // Found nested list, render dropdown menu
    } else if ($(this).children('ul').length) {
      const nestedList = $(this).children('ul').first();
      const dropdownTitle = $(this).contents().not('ul');
      // Replace the title with the dropdown wrapper
      dropdownTitle.remove();
      nestedList.wrap('<div class="dropdown-container"></div>');
      $(this).prepend('<button class="dropdown-btn">'
        + `${dropdownTitle} `
        + `${DROPDOWN_BUTTON_ICON_HTML}\n`
        + '</button>');
      // Recursively format nested lists
      nestedList.replaceWith(formatSiteNav(nestedList.parent().html()));
    }
  });
  return $.html();
}

function unique(array) {
  return array.filter((item, pos, self) => self.indexOf(item) === pos);
}

Page.prototype.prepareTemplateData = function () {
  const prefixedTitle = this.titlePrefix
    ? this.titlePrefix + (this.title ? TITLE_PREFIX_SEPARATOR + this.title : '')
    : this.title;

  return {
    asset: this.asset,
    baseUrl: this.baseUrl,
    content: this.content,
    faviconUrl: this.faviconUrl,
    title: prefixedTitle,
  };
};

/**
 * Records h1,h2,h3 headings into this.headings
 * @param renderedPage a page with its headings rendered
 */
Page.prototype.collectHeadings = function (renderedPage) {
  const $ = cheerio.load(renderedPage);
  if (this.headingIndexingLevel > 0) {
    let headingsSelector = 'h1';
    for (let i = 2; i <= this.headingIndexingLevel; i += 1) {
      headingsSelector += `, h${i}`;
    }
    $(headingsSelector).each((i, heading) => {
      this.headings[$(heading).attr('id')] = $(heading).text();
    });
  }
  return renderedPage;
};

/**
 * Records the dynamic or static included files into this.includedFiles
 * @param dependencies array of maps of the external dependency and where it is included
 */
Page.prototype.collectIncludedFiles = function (dependencies) {
  dependencies.forEach((dependency) => {
    this.includedFiles[dependency.to] = true;
  });
};

/**
 * Records the front matter into this.frontMatter
 * @param includedPage a page with its dependencies included
 */
Page.prototype.collectFrontMatter = function (includedPage) {
  const $ = cheerio.load(includedPage);
  const frontMatter = $('frontmatter');
  if (frontMatter.length) {
    // Retrieves the front matter from either the first frontmatter element
    // or from a frontmatter element that includes from another file
    // The latter case will result in the data being wrapped in a div
    const frontMatterData = frontMatter.find('div').length
      ? frontMatter.find('div')[0].children[0].data
      : frontMatter[0].children[0].data;
    const frontMatterWrapped = `${FRONT_MATTER_FENCE}\n${frontMatterData}\n${FRONT_MATTER_FENCE}`;
    // Parse front matter data
    const parsedData = fm(frontMatterWrapped);
    this.frontMatter = parsedData.attributes;
    this.frontMatter.src = this.src;
    // Title specified in site.json will override title specified in front matter
    this.frontMatter.title = (this.title || this.frontMatter.title || '');
  } else {
    // Page is addressable but no front matter specified
    this.frontMatter = {
      src: this.src,
      title: this.title || '',
    };
  }
  this.title = this.frontMatter.title;
};

/**
 * Removes the front matter from an included page
 * @param includedPage a page with its dependencies included
 */
Page.prototype.removeFrontMatter = function (includedPage) {
  const $ = cheerio.load(includedPage);
  const frontMatter = $('frontmatter');
  frontMatter.remove();
  return $.html();
};

/**
 * Inserts the footer specified in front matter to the end of the page
 * @param pageData a page with its front matter collected
 */
Page.prototype.insertFooter = function (pageData) {
  const { footer } = this.frontMatter;
  if (!footer) {
    return pageData;
  }
  // Retrieve Markdown file contents
  const footerPath = path.join(this.rootPath, FOOTERS_FOLDER_PATH, footer);
  const footerContent = fs.readFileSync(footerPath, 'utf8');
  // Set footer file as an includedFile
  this.includedFiles[footerPath] = true;
  // Map variables
  const newBaseUrl = calculateNewBaseUrl(this.sourcePath, this.rootPath, this.baseUrlMap) || '';
  const userDefinedVariables = this.userDefinedVariablesMap[path.join(this.rootPath, newBaseUrl)];
  return `${pageData}\n${nunjucks.renderString(footerContent, userDefinedVariables)}`;
};

/**
 * Inserts a site navigation bar using the file specified in the front matter
 * @param pageData, a page with its front matter collected
 */
Page.prototype.insertSiteNav = function (pageData) {
  const { siteNav } = this.frontMatter;
  if (!siteNav) {
    return pageData;
  }
  // Retrieve Markdown file contents
  const siteNavPath = path.join(this.rootPath, NAVIGATION_FOLDER_PATH, siteNav);
  const siteNavContent = fs.readFileSync(siteNavPath, 'utf8');
  // Set siteNav file as an includedFile
  this.includedFiles[siteNavPath] = true;
  // Map variables
  const newBaseUrl = calculateNewBaseUrl(this.sourcePath, this.rootPath, this.baseUrlMap) || '';
  const userDefinedVariables = this.userDefinedVariablesMap[path.join(this.rootPath, newBaseUrl)];
  const siteNavMappedData = nunjucks.renderString(siteNavContent, userDefinedVariables);
  // Convert to HTML
  const siteNavDataSelector = cheerio.load(siteNavMappedData);
  const siteNavHtml = md.render(siteNavDataSelector('markdown').html().trim());
  const formattedSiteNav = formatSiteNav(siteNavHtml);
  siteNavDataSelector('markdown').replaceWith(formattedSiteNav);
  // Wrap sections
  const wrappedSiteNav = `<div id="${SITE_NAV_ID}">\n${siteNavDataSelector.html()}\n</div>`;
  const wrappedPageData = `<div id="${PAGE_CONTENT_ID}">\n${pageData}\n</div>`;

  return `<div id="${FLEX_BODY_DIV_ID}">`
    + `${wrappedSiteNav}`
    + `${SITE_NAV_BUTTON_HTML}`
    + `${wrappedPageData}`
    + '</div>';
};

Page.prototype.generate = function (builtFiles) {
  this.includedFiles = {};
  this.includedFiles[this.sourcePath] = true;

  const markbinder = new MarkBind({
    errorHandler: logger.error,
  });
  const fileConfig = {
    baseUrlMap: this.baseUrlMap,
    rootPath: this.rootPath,
    userDefinedVariablesMap: this.userDefinedVariablesMap,
  };
  return new Promise((resolve, reject) => {
    markbinder.includeFile(this.sourcePath, fileConfig)
      .then((result) => {
        this.collectFrontMatter(result);
        return this.removeFrontMatter(result);
      })
      .then(result => this.insertSiteNav((result)))
      .then(result => this.insertFooter(result)) // Footer has to be inserted last to ensure proper formatting
      .then(result => formatFooter(result))
      .then(result => markbinder.resolveBaseUrl(result, fileConfig))
      .then(result => fs.outputFileAsync(this.tempPath, result))
      .then(() => markbinder.renderFile(this.tempPath, fileConfig))
      .then(result => this.collectHeadings(result))
      .then((result) => {
        this.content = htmlBeautify(result, { indent_size: 2 });

        const newBaseUrl = calculateNewBaseUrl(this.sourcePath, this.rootPath, this.baseUrlMap);
        const baseUrl = newBaseUrl ? `${this.baseUrl}/${newBaseUrl}` : this.baseUrl;
        const hostBaseUrl = this.baseUrl;

        this.content = nunjucks.renderString(this.content, { baseUrl, hostBaseUrl });
        return fs.outputFileAsync(this.resultPath, this.template(this.prepareTemplateData()));
      })
      .then(() => {
        const resolvingFiles = [];
        unique(markbinder.getDynamicIncludeSrc()).forEach((source) => {
          if (!FsUtil.isUrl(source.to)) {
            resolvingFiles.push(this.resolveDependency(source, builtFiles));
          }
        });
        return Promise.all(resolvingFiles);
      })
      .then(() => {
        this.collectIncludedFiles(markbinder.getDynamicIncludeSrc());
        this.collectIncludedFiles(markbinder.getStaticIncludeSrc());
        this.collectIncludedFiles(markbinder.getBoilerplateIncludeSrc());
        this.collectIncludedFiles(markbinder.getMissingIncludeSrc());
      })
      .then(resolve)
      .catch(reject);
  });
};

/**
 * Pre-render an external dynamic dependency
 * Does not pre-render if file is already pre-rendered by another page during site generation
 * @param dependency a map of the external dependency and where it is included
 * @param builtFiles set of files already pre-rendered by another page
 */
Page.prototype.resolveDependency = function (dependency, builtFiles) {
  const source = dependency.from;
  const file = dependency.asIfTo;
  return new Promise((resolve, reject) => {
    const resultDir = path.dirname(path.resolve(this.resultPath, path.relative(this.sourcePath, file)));
    const resultPath = path.join(resultDir, FsUtil.setExtension(path.basename(file), '._include_.html'));

    if (builtFiles[resultPath]) {
      return resolve();
    }

    // eslint-disable-next-line no-param-reassign
    builtFiles[resultPath] = true;

    /*
     * We create a local instance of Markbind for an empty dynamicIncludeSrc
     * so that we only recursively rebuild the file's included content
     */
    const markbinder = new MarkBind({
      errorHandler: logger.error,
    });

    let tempPath;
    if (FsUtil.isInRoot(this.rootPath, file)) {
      tempPath = path.join(path.dirname(this.tempPath), path.relative(this.rootPath, file));
    } else {
      logger.info(`Converting dynamic external resource ${file} to ${resultPath}`);
      tempPath = path.join(path.dirname(this.tempPath), '.external', path.basename(file));
    }
    return markbinder.includeFile(dependency.to, {
      baseUrlMap: this.baseUrlMap,
      userDefinedVariablesMap: this.userDefinedVariablesMap,
      rootPath: this.rootPath,
      cwf: file,
    })
      .then(result => this.removeFrontMatter(result))
      .then(result => markbinder.resolveBaseUrl(result, {
        baseUrlMap: this.baseUrlMap,
        rootPath: this.rootPath,
        isDynamic: true,
        dynamicSource: source,
      }))
      .then(result => fs.outputFileAsync(tempPath, result))
      .then(() => markbinder.renderFile(tempPath, {
        baseUrlMap: this.baseUrlMap,
        rootPath: this.rootPath,
      }))
      .then((result) => {
        // resolve the site base url here
        const newBaseUrl = calculateNewBaseUrl(file, this.rootPath, this.baseUrlMap);
        const baseUrl = newBaseUrl ? `${this.baseUrl}/${newBaseUrl}` : this.baseUrl;
        const hostBaseUrl = this.baseUrl;

        const content = nunjucks.renderString(result, { baseUrl, hostBaseUrl });
        return fs.outputFileAsync(resultPath, htmlBeautify(content, { indent_size: 2 }));
      })
      .then(() => {
        // Recursion call to resolve nested dependency
        const resolvingFiles = [];
        unique(markbinder.getDynamicIncludeSrc()).forEach((src) => {
          if (!FsUtil.isUrl(src.to)) resolvingFiles.push(this.resolveDependency(src, builtFiles));
        });
        return Promise.all(resolvingFiles);
      })
      .then(() => {
        this.collectIncludedFiles(markbinder.getDynamicIncludeSrc());
        this.collectIncludedFiles(markbinder.getStaticIncludeSrc());
        this.collectIncludedFiles(markbinder.getBoilerplateIncludeSrc());
        this.collectIncludedFiles(markbinder.getMissingIncludeSrc());
      })
      .then(resolve)
      .catch(reject);
  });
};

module.exports = Page;