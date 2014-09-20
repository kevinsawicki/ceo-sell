var cheerio   = require('cheerio');
var ceos      = require('./ceos.json');
var Humanize  = require('humanize-plus');
var request   = require('request');
var url       = require('url');
var XmlStream = require('xml-stream');

var getLatestFiling = function(id, callback) {
  var requestOptions = {
    uri: 'http://www.sec.gov/cgi-bin/browse-edgar',
    qs: {
      action: 'getcompany',
      CIK: id,
      count: 1,
      output: 'atom',
      owner: 'include',
      type: 4
    }
  };

  var parser = new XmlStream(request(requestOptions), 'utf8');
  parser.once('text: filing-href', function (node) {
    var text = node.$text.trim();
    callback(null, text);
  });
};

var getFilingXmlFileUrl = function(filingHref, callback) {
  var folderUrl = url.resolve(filingHref, '.');
  request(folderUrl, function(error, response, body) {
    var fileName = cheerio(body).find('a[href$=".xml"]').first().text();
    var fileUrl = url.resolve(folderUrl, fileName);
    callback(null, fileUrl);
  });
};

var getFilingHtmlFileUrl = function(filingHref, callback) {
  request(filingHref, function(error, response, body) {
    var htmlName = cheerio(body).find('a[href^="/Archives"]').first().attr('href');
    var htmlUrl = url.resolve("http://www.sec.gov/", htmlName);
    callback(null, htmlUrl);
  });
}

var parseFilingXml = function(xmlFileUrl, callback) {
  var parser = new XmlStream(request(xmlFileUrl), 'utf8');

  var totalShares = 0;
  var amountInDollars = 0;

  var currentShares;
  var currentPrice;
  var currentType;

  parser.on('startElement: transactionAmounts', function(name) {
    currentPrice = 0;
    currentShares = 0;
    currentType = null;
  });

  parser.on('text: transactionAmounts > transactionShares > value', function(node) {
    currentShares = parseFloat(node.$text);
  });

  parser.on('text: transactionAmounts > transactionPricePerShare > value', function(node) {
    currentPrice = parseFloat(node.$text);
  });

  parser.on('text: transactionAmounts > transactionAcquiredDisposedCode > value', function(node) {
    currentType = node.$text.trim();
  });

  parser.on('endElement: transactionAmounts', function(name) {
    if (currentType === 'D') {
      if (currentPrice > 0 && isFinite(currentPrice)) {
        if (currentShares > 0 && isFinite(currentShares)) {
          totalShares += currentShares;
          amountInDollars += currentPrice * currentShares;
        }
      }
    }
  });

  parser.on('end', function () {
    callback(null, totalShares, amountInDollars);
  });
};

var getLatestTransaction = function(id, callback) {
  getLatestFiling(id, function(error, filingHref) {
    getFilingXmlFileUrl(filingHref, function(error, xmlFileUrl) {
      getFilingHtmlFileUrl(filingHref, function(error, htmlFileUrl) {
        parseFilingXml(xmlFileUrl, function (error, shares, dollarAmount) {
          callback(null, htmlFileUrl, shares, dollarAmount);
        });
      });
    });
  });
};

var generateTweet = function(ceo, filingUrl, shares, dollarAmount) {
  return ceo.name + " sold " + Humanize.compactInteger(shares, 0) + " shares for $" + Humanize.compactInteger(dollarAmount, 1) + " " + filingUrl;
}

Object.keys(ceos).forEach(function(id) {
  getLatestTransaction(id, function(error, filingUrl, shares, dollarAmount) {
    if (shares > 0 && dollarAmount > 0)
      console.log(generateTweet(ceos[id], filingUrl, shares, dollarAmount));
  });
});
