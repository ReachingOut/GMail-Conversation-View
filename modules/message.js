var EXPORTED_SYMBOLS = ['Message', 'MessageFromGloda', 'MessageFromDbHdr']

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource:///modules/XPCOMUtils.jsm"); // for generateQI
Cu.import("resource:///modules/StringBundle.js"); // for StringBundle
Cu.import("resource:///modules/PluralForm.jsm");
Cu.import("resource:///modules/templateUtils.js"); // for makeFriendlyDateAgo
Cu.import("resource:///modules/gloda/mimemsg.js");
Cu.import("resource:///modules/gloda/connotent.js"); // for mimeMsgToContentSnippetAndMeta

const gMessenger = Cc["@mozilla.org/messenger;1"]
                   .createInstance(Ci.nsIMessenger);
const gHeaderParser = Cc["@mozilla.org/messenger/headerparser;1"]
                      .getService(Ci.nsIMsgHeaderParser);
const gMsgTagService = Cc["@mozilla.org/messenger/tagservice;1"]
                       .getService(Ci.nsIMsgTagService);
const ioService = Cc["@mozilla.org/network/io-service;1"]
                  .getService(Ci.nsIIOService);
const kCharsetFromMetaTag = 10;
const kAllowRemoteContent = 2;

let strings = new StringBundle("chrome://conversations/locale/main.properties");

Cu.import("resource://conversations/VariousUtils.jsm");
Cu.import("resource://conversations/MsgHdrUtils.jsm");
Cu.import("resource://conversations/prefs.js");
Cu.import("resource://conversations/contact.js");
Cu.import("resource://conversations/hook.js");
Cu.import("resource://conversations/log.js");

let Log = setupLogging("Conversations.Message");
const snippetLength = 300;

// Add in the global message listener table a weak reference to the given
//  Message object. The monkey-patch which intercepts the "remote content
//  blocked" notification will then look for a suitable listener on notify it of
//  the aforementioned event.
function addMsgListener(aMessage) {
  let window = getMail3Pane();
  let weakPtr = Cu.getWeakReference(aMessage);
  let msgListeners = window.Conversations.msgListeners;
  let messageId = aMessage._msgHdr.messageId;
  if (!(messageId in msgListeners))
    msgListeners[messageId] = [];
  msgListeners[messageId].push(weakPtr);
}

function KeyListener(aMessage) {
  this.message = aMessage;
  let mail3PaneWindow = getMail3Pane();
  this.KeyEvent = mail3PaneWindow.KeyEvent;
  this.navigator = mail3PaneWindow.navigator;
}

KeyListener.prototype = {
  onKeyPress: function _KeyListener_onKeyPressed (event) {
    let self = this;
    let isAccel = function (event) (
       self.navigator.platform.indexOf("Mac") === 0 && event.metaKey
       || event.ctrlKey
    );
    let findMsgNode = function (msgNode) {
      let msgNodes = self.message._domNode.ownerDocument
        .getElementsByClassName(Message.prototype.cssClass);
      msgNodes = [x for each ([, x] in Iterator(msgNodes))];
      let index = msgNodes.indexOf(msgNode);
      return [msgNodes, index];
    };
    switch (event.which) {
      case this.KeyEvent.DOM_VK_RETURN:
      case 'o'.charCodeAt(0):
        this.message.toggle();
        event.preventDefault();
        break;

      case 'n'.charCodeAt(0):
        {
          let [msgNodes, index] = findMsgNode(this.message._domNode);
          if (index < (msgNodes.length - 1)) {
            let next = msgNodes[index+1];
            next.focus();
            this.message._conversation._htmlPane
              .contentWindow.scrollNodeIntoView(next);
          }
          event.preventDefault();
        }
        break;

      case 'p'.charCodeAt(0):
        {
          let [msgNodes, index] = findMsgNode(this.message._domNode);
          if (index > 0) {
            let prev = msgNodes[index-1];
            prev.focus();
            this.message._conversation._htmlPane
              .contentWindow.scrollNodeIntoView(prev);
          }
          event.preventDefault();
        }
        break;

      case 'r'.charCodeAt(0):
        if (isAccel(event))
          this.message.compose(Ci.nsIMsgCompType.ReplyToSender, event);
        event.preventDefault();
        break;

      case 'R'.charCodeAt(0):
        if (isAccel(event))
          this.message.compose(Ci.nsIMsgCompType.ReplyAll, event);
        event.preventDefault();
        break;

      case 'l'.charCodeAt(0):
        this.message.forward(event);
        event.preventDefault();
        break;

      case 'u'.charCodeAt(0):
        // Hey, let's move back to this message next time!
        this.message._domNode.setAttribute("tabindex", "1");
        getMail3Pane().SetFocusThreadPane(event);
        event.preventDefault();
        break;

      case 'a'.charCodeAt(0):
        msgHdrsArchive(this.message._conversation.msgHdrs);
        event.preventDefault();
        break;

      case '#'.charCodeAt(0):
        msgHdrsDelete(this.message._conversation.msgHdrs);
        event.preventDefault();
        break;
    }
  },
}

// Call that one after setting this._msgHdr;
function Message(aConversation) {
  this._didStream = false;
  this._domNode = null;
  this._snippet = "";
  this._conversation = aConversation;

  let date = new Date(this._msgHdr.date/1000);
  this._date = Prefs["no_friendly_date"] ? dateAsInMessageList(date) : makeFriendlyDateAgo(date);
  // This one is for display purposes
  this._from = this.parse(this._msgHdr.mime2DecodedAuthor)[0];
  // Might be filled to something more meaningful later, in case we replace the
  //  sender with something more relevant, like X-Bugzilla-Who.
  this._realFrom = "";
  this._to = this.parse(this._msgHdr.mime2DecodedRecipients);
  this._cc = this.parse(this._msgHdr.ccList);
  this._bcc = this.parse(this._msgHdr.bccList);
  this.subject = this._msgHdr.mime2DecodedSubject;

  this._uri = this._msgHdr.folder.getUriForMsg(this._msgHdr);
  this._contacts = [];
  this._attachments = [];
}

Message.prototype = {
  cssClass: "message",

  // Joins together names and format them as "John, Jane and Julie"
  join: function (aElements) {
    let l = aElements.length;
    if (l == 0)
      return "";
    else if (l == 1)
      return aElements[0];
    else {
      let hd = aElements.slice(0, l - 1);
      let tl = aElements[l-1];
      return hd.join(", ") + " and " + tl;
    }
  },

  // Wraps the low-level header parser stuff.
  //  @param aMimeLine a line that looks like "John <john@cheese.com>, Jane <jane@wine.com>"
  //  @return a list of { email, name } objects
  parse: function (aMimeLine) {
    let emails = {};
    let fullNames = {};
    let names = {};
    let numAddresses = gHeaderParser.parseHeadersWithArray(aMimeLine, emails, names, fullNames);
    return [{ email: emails.value[i], name: names.value[i] }
      for each (i in range(0, numAddresses))];
  },

  // Picks whatever's available from an { email, name } and return it as
  // suitable for insertion into HTML
  format: function (p) {
    return (p ? escapeHtml(p.name || p.email) : "");
  },

  // Output this message as a whole bunch of HTML
  toHtmlString: function () {
    let self = this;

    // 1) Generate Contact objects
    let contactFrom = this._conversation._contactManager
      .getContactFromNameAndEmail(this._from.name, this._from.email);
    this._contacts.push(contactFrom);
    // true means "with colors"
    let fromStr = contactFrom.toHtmlString(true, Contacts.kFrom);

    let to = this._to.concat(this._cc).concat(this._bcc);
    let contactsTo = to.map(function (x) {
      return self._conversation._contactManager
        .getContactFromNameAndEmail(x.name, x.email);
    });
    this._contacts = this._contacts.concat(contactsTo);
    // false means "no colors"
    let toStr = this.join(contactsTo.map(function (x) x.toHtmlString(false, Contacts.kTo)));

    // 2) Generate Attachment objects
    let attachmentsHtml = "";
    let paperclip = "";
    if (this._attachments.length) {
      paperclip = "<img src=\"chrome://conversations/content/i/attachment.png\" /> ";

      let l = this._attachments.length;
      let [makePlural, ] = PluralForm.makeGetter("1");
      let plural = makePlural(l, "one attachment;#1 attachments").replace("#1", l);
      attachmentsHtml = [
        "<ul class=\"attachments\">",
          "<div class=\"attachHeader\">", plural,
            " | <a href=\"javascript:\" class=\"link download-all\">download all</a>",
            //" | <a href=\"javascript:\" class=\"view-all\">view all</a>"
          "</div>"
      ];
      for each (let [i, att] in Iterator(this._attachments)) {
        let [thumb, imgClass] = (att.contentType.indexOf("image/") === 0)
          ? [att.url, "resize-me"]
          : ["moz-icon://" + att.name + "?size=" + 64 + "&contentType=" + att.contentType, "center-me"]
        ;
        let formattedSize = gMessenger.formatFileSize(att.size);
        // XXX remove this when bug 559559 is fixed!
        formattedSize = formattedSize.substring(0, formattedSize.length - 1);
        attachmentsHtml = attachmentsHtml.concat([
          "<li class=\"clearfix hbox attachment\">",
            "<div class=\"attachmentThumb\"><img class=\"", imgClass, "\" src=\"", thumb, "\"></div>",
            "<div class=\"attachmentInfo align\">",
              "<span class=\"filename\">", att.name, "</span>",
              "<div class=\"attachActions\">", formattedSize,
                " | <a href=\"javascript:\" class=\"link open-attachment\">open</a>",
                " | <a href=\"javascript:\" class=\"link download-attachment\">download</a>",
              "</div>",
            "</div>",
          "</li>",
        ]);
      }
      attachmentsHtml = attachmentsHtml.concat([
        "</ul>",
      ]);
      attachmentsHtml = attachmentsHtml.join("");
    }

    // 3) Generate extra information: snippet, date
    let snippet = escapeHtml(this._snippet);
    let date = escapeHtml(this._date);

    // 4) Custom tag telling the user if the message is not in the current view
    let folderTag = "";
    let threadKey = getMail3Pane().gDBView
      .getThreadContainingMsgHdr(this._conversation._initialSet[0]).threadKey;
    let myThreadKey;
    try {
      myThreadKey = getMail3Pane().gDBView
        .getThreadContainingMsgHdr(this._msgHdr).threadKey;
    } catch (e) {
      myThreadKey = -1;
    }
    if (threadKey != myThreadKey) {
      let folderStr = this._msgHdr.folder.prettiestName;
      let folder = this._msgHdr.folder;
      while (folder.parent) {
        folder = folder.parent;
        folderStr = folder.name + "/" + folderStr;
      }
      folderTag = "<li class=\"keep-tag in-folder\">In "+folderStr+"</li>";
    }

    // 5) Custom tag telling the user if this is a draft
    let editDraft = "";
    if (msgHdrIsDraft(this._msgHdr)) {
      editDraft = "<li class=\"keep-tag edit-draft\">Draft (edit)</li>";
    }

    let r = [
      "<li class=\"message collapsed\">",
      //"  <!-- Message-ID: ", this._msgHdr.messageId, " -->",
        "<div class=\"messageHeader hbox\">",
          "<div class=\"star\">",
          "</div>",
          "<div class=\"author\">",
            "", fromStr, "",
          "</div>",
          "<div class=\"involved boxFlex\">",
            "<span class=\"to\">to ", toStr, "</span>",
            "<span class=\"snippet\"><ul class=\"tags regular-tags\"></ul>", snippet, "</span>",
          "</div>",
          "<div class=\"options\">",
            "<span class=\"date\">", paperclip, date, "</span>",
            "<span class=\"details\"> | <a href=\"javascript:\">details</a> |</span> ",
            "<span class=\"dropDown\">",
              "<a href=\"javascript:\">more <span class=\"downwardArrow\">&#x25bc;</span></a>",
              "<div class=\"tooltip\">",
                "<ul>",
                  "<li class=\"action-archive\">archive this message",
                    "<div class=\"arrow\"></div>",
                    "<div class=\"arrow inside\"></div>",
                  "</li>",
                  "<li class=\"action-delete\">delete this message</li>",
                  "<li class=\"action-monospace\">this sender sends monospace</li>",
                  "<li class=\"action-classic\">view using the classic reader</li>",
                  "<li class=\"action-source\">view message source</li>",
                "</ul>",
              "</div>",
            "</span>",
          "</div>",
        "</div>",
        "<div class=\"messageBody\">",
          "<ul class=\"tags special-tags\">",
            "<li class=\"keep-tag show-remote-content\">show remote content</li>",
            "<li class=\"keep-tag always-display\">always display remote content</li>",
            folderTag,
            editDraft,
          "</ul>",
          "<ul class=\"tags regular-tags\"></ul>",
          "<div class=\"iframe-container\"></div>",
          attachmentsHtml,
        "</div>",
        "<div class=\"messageFooter\">",
          "<button class=\"reply\">reply</button>",
          "<button class=\"replyAll\">reply all</button>",
          "<button class=\"forward\">forward</button>",
          "<button style=\"float:right;margin: 0 0 0 0;\">more...</button>",
        "</div>",
      "</li>"
    ].join("");
    return r;
  },

  // Once the conversation has added us into the DOM, we're notified about it
  //  (aDomNode is us), and we can start registering event handlers and stuff
  onAddedToDom: function (aDomNode) {
    if (!aDomNode) {
      Log.error("onAddedToDom() && !aDomNode", this.from, this.to, this.subject);
    }

    // This allows us to pre-set the star and the tags in the right original
    //  state
    this._domNode = aDomNode;
    this.onAttributesChanged(this);

    let self = this;
    this._domNode.getElementsByClassName("messageHeader")[0]
      .addEventListener("click", function () self.toggle(), false);

    let keyListener = new KeyListener(this);
    this._domNode.addEventListener("keypress", function (event) {
      keyListener.onKeyPress(event);
    }, false);
  },

  notifiedRemoteContentAlready: false,

  // The global monkey-patch finds us through the weak pointer table and
  //  notifies us.
  onMsgHasRemoteContent: function _Message_onMsgHasRemoteContent () {
    if (this.notifiedRemoteContentAlready)
      return;
    this.notifiedRemoteContentAlready = true;
    Log.debug("This message's remote content was blocked");

    this._domNode.getElementsByClassName("show-remote-content")[0].style.display = "inline";
    this._domNode.getElementsByClassName("always-display")[0].style.display = "inline";
  },

  compose: function _Message_compose (aCompType, aEvent) {
    let window = getMail3Pane();
    if (aEvent.shiftKey) {
      window.ComposeMessage(aCompType, Ci.nsIMsgCompFormat.OppositeOfDefault, this._msgHdr.folder, [this._uri]);
    } else {
      window.ComposeMessage(aCompType, Ci.nsIMsgCompFormat.Default, this._msgHdr.folder, [this._uri]);
    }
  },

  forward: function _Message_forward (event) {
    let forwardType = 0;
    try {
      forwardType = Prefs.getInt("mail.forward_message_mode");
    } catch (e) {
      Log.error("Unable to fetch preferred forward mode\n");
    }
    if (forwardType == 0)
      this.compose(Ci.nsIMsgCompType.ForwardAsAttachment, event);
    else
      this.compose(Ci.nsIMsgCompType.ForwardInline, event);
  },

  // Actually, we only do these expensive DOM calls when we need to, i.e. when
  //  we're expanded for the first time (expand calls us).
  registerActions: function _Message_registerActions() {
    let self = this;

    // Forward the calls to each contact.
    let people = this._domNode.getElementsByClassName("tooltip");
    [x.onAddedToDom(people[i]) for each ([i, x] in Iterator(this._contacts))];

    // Let the UI do its stuff with the tooltips
    this._conversation._htmlPane.contentWindow.enableTooltips(this);

    // Register all the needed event handlers. Nice wrappers below.
    let register = function _register (selector, f, action) {
      if (!action)
        action = "click";
      let nodes;
      if (selector === null)
        nodes = [self._domNode];
      else if (typeof(selector) == "string")
        nodes = self._domNode.querySelectorAll(selector);
      else
        nodes = [selector];

      for each (let [, node] in Iterator(nodes))
        node.addEventListener(action, f, false);
    };
    register(".reply", function (event) self.compose(Ci.nsIMsgCompType.ReplyToSender, event));
    register(".replyAll", function (event) self.compose(Ci.nsIMsgCompType.ReplyAll, event));
    register(".edit-draft", function (event) self.compose(Ci.nsIMsgCompType.Draft, event));
    register(".forward", function (event) self.forward(event));
    // These event listeners are all in the header, which happens to have an
    //  event listener set on the click event for toggling the message. So we
    //  make sure that event listener is bubbling, and we register these with
    //  the bubbling model as well.
    register(".action-archive", function (event) {
      msgHdrsArchive([self._msgHdr]);
      event.stopPropagation();
    });
    register(".action-delete", function (event) {
      msgHdrsDelete([self._msgHdr]);
      event.stopPropagation();
    });
    register(".action-monospace", function (event) {
      let senders = Prefs["monospaced_senders"] || [];
      let email = self._realFrom.email || self._from.email;
      if (!senders.filter(function (x) x == email).length) {
        Prefs.setChar("conversations.monospaced_senders", senders.concat([email]).join(","));
      }
      self._reloadMessage();
      event.stopPropagation();
    });
    register(".action-classic", function (event) {
      let tabmail = getMail3Pane().document.getElementById("tabmail");
      tabmail.openTab("message", { msgHdr: self._msgHdr, background: false });
      event.stopPropagation();
    });
    register(".action-source", function (event) {
      getMail3Pane().ViewPageSource([self._uri])
      event.stopPropagation();
    });
    register(".star", function (event) {
      self.starred = !self.starred;
      // Don't trust gloda. Big hack, self also has the "starred" property, so
      //  we don't have to create a new object.
      self.onAttributesChanged(self);
      event.stopPropagation();
    });
    register(".tooltip", function (event) {
      // Clicking inside a tooltip must not collapse the message.
      event.stopPropagation();
    });

    // ("" || "blah") == "blah" (empty string evaluates to false)
    let realFrom = String.trim(this._realFrom.email || this._from.email);
    // Actually we might not need that list item, so possibly remove it!
    if (Prefs["monospaced_senders"].filter(function (x) x == realFrom).length) {
      let node = this._domNode.getElementsByClassName("action-monospace")[0];
      node.parentNode.removeChild(node);
    }

    register(".show-remote-content", function (event) {
      event.target.style.display = "none";
      self._msgHdr.setUint32Property("remoteContentPolicy", kAllowRemoteContent);
      self._reloadMessage();
    });
    register(".always-display", function (event) {
      event.target.style.display = "none";
      event.target.previousElementSibling.style.display = "none";

      let { card, book } = getMail3Pane().getCardForEmail(self._from.email);
      let allowRemoteContent = false;
      if (card) {
        // set the property for remote content
        card.setProperty("AllowRemoteContent", true);
        book.modifyCard(card);
        allowRemoteContent = true;
      } else {
        let args = {
          primaryEmail: self._from.email,
          displayName: self._from.name,
          allowRemoteContent: true,
        };
        // create a new card and set the property
        getMail3Pane().openDialog("chrome://messenger/content/addressbook/abNewCardDialog.xul",
                          "", "chrome,resizable=no,titlebar,modal,centerscreen", args);
        allowRemoteContent = args.allowRemoteContent;
      }
 
      // Reload the message if we've updated the remote content policy for the sender.
      if (allowRemoteContent)
        self._reloadMessage();
    });
    register(".in-folder", function (event) {
      getMail3Pane().gFolderTreeView.selectFolder(self._msgHdr.folder, true);
      getMail3Pane().gFolderDisplay.selectMessage(self._msgHdr);
    });

    let attachmentNodes = this._domNode.getElementsByClassName("attachment");
    let attachmentInfos = [];
    let mainWindow = getMail3Pane();
    for each (let [i, attNode] in Iterator(attachmentNodes)) {
      let att = this._attachments[i];

      /* I'm still surprised that this magically works */
      let neckoURL = ioService.newURI(att.url, null, null);
      neckoURL.QueryInterface(Ci.nsIMsgMessageUrl);
      let uri = neckoURL.uri;

      let attInfo = new mainWindow.createNewAttachmentInfo(
        att.contentType, att.url, att.name, uri, att.isExternal
      );
      register(attNode.getElementsByClassName("open-attachment")[0], function (event) {
        Log.debug("Opening attachment");
        mainWindow.HandleMultipleAttachments([attInfo], "open");
      });
      register(attNode.getElementsByClassName("download-attachment")[0], function (event) {
        Log.debug("Downloading attachment");
        mainWindow.HandleMultipleAttachments([attInfo], "save");
      });

      let maybeViewable = 
        att.contentType.indexOf("image/") === 0
        || att.contentType.indexOf("text/") === 0
      ;
      if (maybeViewable) {
        let img = attNode.getElementsByTagName("img")[0];
        img.classList.add("view-attachment");
        img.setAttribute("title", "View this attachment in a new tab");
        register(img, function (event) {
          mainWindow.document.getElementById("tabmail").openTab(
            "contentTab",
            { contentPage: att.url }
          );
        });
      }

      attachmentInfos.push(attInfo);
    }
    register(".open-all", function (event) {
      mainWindow.HandleMultipleAttachments(attachmentInfos, "open");
    });
    register(".download-all", function (event) {
      mainWindow.HandleMultipleAttachments(attachmentInfos, "save");
    });
  },

  _reloadMessage: function _Message_reloadMessage () {
    let specialTags = this._domNode.getElementsByClassName("special-tags")[0];
    // Remove any extra tags because they will be re-added after reload, but
    //  leave the "show remote content" tag.
    for (let i = specialTags.children.length - 1; i >= 0; i--) {
      let child = specialTags.children[i];
      if (!child.classList.contains("keep-tag"))
        specialTags.removeChild(child);
    }
    this.iframe.parentNode.removeChild(this.iframe);
    this.streamMessage();
  },

  get iframe () {
    return this._domNode.getElementsByTagName("iframe")[0];
  },

  cosmeticFixups: function _Message_cosmeticFixups() {
    // Can do this only when expanded, otherwise jQuery won't be able to compute
    //  the height.
    let window = this._conversation._htmlPane.contentWindow;
    window.alignAttachments(this);

    // XXX this is too brutal, do something more elaborate, like add a specific
    //  class
    let toNode = this._domNode.getElementsByClassName("to")[0];
    let style = window.getComputedStyle(toNode, null);
    let overflowed = false;
    while (parseInt(style.height) > 18 && toNode.childNodes.length > 1) {
      toNode.removeChild(toNode.childNodes[toNode.childNodes.length - 1]);
      overflowed = true;
      style = window.getComputedStyle(toNode, null);
    }
    if (overflowed) {
      // Don't use unicode ellipsis here (…) -- will display garbage, don't know
      //  why
      let dots = toNode.ownerDocument.createTextNode("...");
      toNode.appendChild(dots);
      while (parseInt(style.height) > 18 && toNode.childNodes.length > 2) {
        toNode.removeChild(toNode.childNodes[toNode.childNodes.length - 2]);
        style = window.getComputedStyle(toNode, null);
      }
    }
  },

  // {
  //  starred: bool,
  //  tags: nsIMsgTag list,
  // } --> both Message and GlodaMessage implement these attributes
  onAttributesChanged: function _Message_onAttributesChanged({ starred, tags }) {
    // Update "starred" attribute
    if (starred)
      this._domNode.getElementsByClassName("star")[0].classList.add("starred");
    else
      this._domNode.getElementsByClassName("star")[0].classList.remove("starred");

    // Update tags
    let tagList = this._domNode.getElementsByClassName("regular-tags")[0];
    while (tagList.firstChild)
      tagList.removeChild(tagList.firstChild);
    for each (let [, tag] in Iterator(tags)) {
      let colorClass = "blc-" + gMsgTagService.getColorForKey(tag.key).substr(1);
      let tagName = tag.tag;
      let tagNode = this._domNode.ownerDocument.createElement("li");
      tagNode.classList.add("tag");
      tagNode.classList.add(colorClass);
      tagNode.textContent = tagName;
      tagList.appendChild(tagNode);
    }
    this._domNode.getElementsByClassName("regular-tags")[1].innerHTML = tagList.innerHTML;
  },

  // Convenience properties
  get read () {
    return this._msgHdr.isRead;
  },

  get starred () {
    return this._msgHdr.isFlagged;
  },

  set starred (v) {
    this._msgHdr.markFlagged(v);
  },

  get tags () {
    return msgHdrGetTags(this._msgHdr);
  },

  get collapsed () {
    return this._domNode.classList.contains("collapsed");
  },

  get expanded () {
    return !this.collapsed;
  },

  toggle: function () {
    if (this.collapsed)
      this.expand();
    else if (this.expanded)
      this.collapse();
    else
      Log.error("WTF???");
  },

  _signal: function _Message_signal () {
    this._conversation._signal();
  },

  expand: function () {
    this._domNode.classList.remove("collapsed");
    if (!this._didStream) {
      try {
        this.registerActions();
        this.cosmeticFixups();
        this.streamMessage(); // will call _signal
      } catch (e) {
        Log.error(e);
        dumpCallStack(e);
      }
    } else {
      this._signal();
    }
  },

  collapse: function () {
    this._domNode.classList.add("collapsed");
  },

  // This function takes care of streaming the message into the <iframe>, adding
  // it into the DOM tree, watching for completion, reloading if necessary
  // (BidiUI), applying the various heuristics for detecting quoted parts,
  // changing the monospace font for the default one, possibly decrypting the
  // message using Enigmail, making coffee...
  streamMessage: function () {
    Log.assert(this.expanded, "Cannot stream a message if not expanded first!");

    let originalScroll = this._domNode.ownerDocument.documentElement.scrollTop;
    let msgWindow = getMail3Pane().msgWindow;

    let iframe = this._domNode.ownerDocument
      .createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "iframe");
    iframe.setAttribute("transparent", "transparent"); // Big hack to workaround bug 540911
    iframe.setAttribute("style", "height: 20px");
    iframe.setAttribute("type", "content");

    // The xul:iframe automatically loads about:blank when it is added
    // into the tree. We need to wait for the document to be loaded before
    // doing things.
    //
    // Why do we do that? Basically because we want the <xul:iframe> to
    // have a docShell and a webNavigation. If we don't do that, and we
    // set directly src="about:blank" above, sometimes we are too fast and
    // the docShell isn't ready by the time we get there.
    let self = this;
    iframe.addEventListener("load", function f_temp2(event, aCharset) {
      try {
        iframe.removeEventListener("load", f_temp2, true);

        // The second load event is triggered by loadURI with the URL
        // being the necko URL to the given message.
        iframe.addEventListener("load", function f_temp1(event) {
          try {
            iframe.removeEventListener("load", f_temp1, true);
            // XXX cut this off and turn into a this._onMessageStreamed
            let iframeDoc = iframe.contentDocument;

            // Do some reformatting + deal with people who have bad taste
            iframeDoc.body.setAttribute("style", "padding: 0; margin: 0; "+
              "color: rgb(10, 10, 10); background-color: transparent; "+
              "-moz-user-focus: none !important; ");

            // Remove the attachments if the user has not set View >
            // Display Attachments Inline. Do that right now, otherwise the
            // quoted text detection will mess up the markup.
            let fieldsets = iframeDoc.getElementsByClassName("mimeAttachmentHeader");
            for (let i = fieldsets.length - 1; i >= 0; i--) {
              Log.warn("Found an attachment, removing... please uncheck View > Display attachments inline.");
              let node = fieldsets[i];
              while (node.nextSibling)
                node.parentNode.removeChild(node.nextSibling);
              node.parentNode.removeChild(node);
            }

            // Launch various crappy pieces of code^W^W^W^W heuristics to
            //  convert most common quoting styles to real blockquotes. Spoiler:
            //  most of them suck.
            try {
              convertOutlookQuotingToBlockquote(iframe.contentWindow, iframeDoc);
              convertHotmailQuotingToBlockquote1(iframeDoc);
              convertHotmailQuotingToBlockquote2(iframe.contentWindow, iframeDoc, Prefs["hide_quote_length"]);
              convertForwardedToBlockquote(iframeDoc);
              fusionBlockquotes(iframeDoc);
            } catch (e) {
              Log.warn(e);
              dumpCallStack(e);
            }
            // this function adds a show/hide quoted text link to every topmost
            // blockquote. Nested blockquotes are not taken into account.
            let walk = function walk_ (elt) {
              for (let i = elt.childNodes.length - 1; i >= 0; --i) {
                let c = elt.childNodes[i];
                // GMail uses class="gmail_quote", other MUAs use type="cite"...
                // so just search for a regular blockquote
                if (c.tagName && c.tagName.toLowerCase() == "blockquote") {
                  if (c.getUserData("hideme") !== false) { // null is ok, true is ok too
                    // Compute the approximate number of lines while the element is still visible
                    let style;
                    try {
                      style = iframe.contentWindow.getComputedStyle(c, null);
                    } catch (e) {
                      // message arrived and window is not displayed, arg,
                      // cannot get the computed style, BAD
                    }
                    if (style) {
                      let numLines = parseInt(style.height) / parseInt(style.lineHeight);
                      if (numLines > Prefs["hide_quote_length"]) {
                        let showText = strings.get("showquotedtext");
                        let hideText = strings.get("hidequotedtext");
                        let div = iframeDoc.createElement("div");
                        div.setAttribute("class", "link showhidequote");
                        div.addEventListener("click", function div_listener (event) {
                          let h = self._conversation._htmlPane.contentWindow.toggleQuote(event, showText, hideText);
                          iframe.style.height = (parseFloat(iframe.style.height) + h)+"px";
                        }, true);
                        div.setAttribute("style", "color: orange; cursor: pointer; font-size: 11px;");
                        div.appendChild(self._domNode.ownerDocument
                          .createTextNode("- "+showText+" -"));
                        elt.insertBefore(div, c);
                        c.style.display = "none";
                      }
                    }
                  }
                } else {
                  walk(c);
                }
              }
            };
            walk(iframeDoc);

            // Ugly hack (once again) to get the style inside the
            // <iframe>. I don't think we can use a chrome:// url for
            // the stylesheet because the iframe has a type="content"
            let style = iframeDoc.createElement("style");
            let defaultFont = Prefs.getChar("font.default");
            style.appendChild(iframeDoc.createTextNode(
              ".pre-as-regular {\n"+
              "  font-family: "+defaultFont+" !important;\n"+
              "  font-size: 12px !important;\n"+
              "  line-height: 18px !important;\n"+
              "}\n"
            ));
            iframeDoc.body.previousElementSibling.appendChild(style);

            // Our super-advanced heuristic ;-)
            let isPlainText =
              iframeDoc.body.firstElementChild &&
              (iframeDoc.body.firstElementChild.classList.contains("moz-text-flowed") ||
               iframeDoc.body.firstElementChild.classList.contains("moz-text-plain"));

            // The manipulations below are only valid for plain/text messages
            if (isPlainText) {
              // Unless the user specifically asked for this message to be
              // dislayed with a monospaced font...
              let [{name, email}] = self.parse(self._msgHdr.mime2DecodedAuthor);
              if (Prefs["monospaced_senders"].indexOf(email) < 0) {
                let elts = iframeDoc.querySelectorAll("pre, body > *:first-child")
                for each (let [, elt] in Iterator(elts))
                  elt.classList.toggle("pre-as-regular");
              }
            }

            // Notify hooks that we just finished displaying a message. Must be
            //  performed now, not later.
            try {
              [h.onMessageStreamed(self._msgHdr, self._domNode) for each ([, h] in Iterator(getHooks()))];
            } catch (e) {
              Log.warn("Plugin returned an error:", e);
              dumpCallStack(e);
            }

            // For bidiUI. Do that now because the DOM manipulations are
            //  over. We can't do this before because BidiUI screws up the
            //  DOM. Don't know why :(.
            // We can't do this as a plugin (I wish I could!) because this is
            //  too entangled with the display logic.
            let mainWindow = getMail3Pane();
            if ("BiDiMailUI" in mainWindow) {
              let ActionPhases = mainWindow.BiDiMailUI.Display.ActionPhases;
              try {
                let domDocument = iframe.docShell.contentViewer.DOMDocument;
                let body = domDocument.body;

                let BDMCharsetPhaseParams = {
                  body: body,
                  charsetOverrideInEffect: msgWindow.charsetOverride,
                  currentCharset: msgWindow.mailCharacterSet,
                  messageHeader: self._msgHdr,
                  unusableCharsetHandler: mainWindow
                    .BiDiMailUI.MessageOverlay.promptForDefaultCharsetChange,
                  needCharsetForcing: false,
                  charsetToForce: null
                };
                ActionPhases.charsetMisdetectionCorrection(BDMCharsetPhaseParams);
                if (BDMCharsetPhaseParams.needCharsetForcing
                    && BDMCharsetPhaseParams.charsetToForce != aCharset) {
                  // XXX this doesn't take into account the case where we
                  // have a cycle with length > 0 in the reloadings.
                  // Currently, I only see UTF8 -> UTF8 cycles.
                  Log.debug("Reloading with "+BDMCharsetPhaseParams.charsetToForce);
                  f_temp2(null, BDMCharsetPhaseParams.charsetToForce);
                  return;
                }
                ActionPhases.htmlNumericEntitiesDecoding(body);
                ActionPhases.quoteBarsCSSFix(domDocument);
                ActionPhases.directionAutodetection(domDocument);
              } catch (e) {
                Log.error(e);
                dumpCallStack(e);
              }
            }

            // Attach the required event handlers so that links open in the
            // external browser.
            for each (let [, a] in Iterator(iframeDoc.getElementsByTagName("a"))) {
              a.addEventListener("click",
                function link_listener (event)
                  mainWindow.specialTabs.siteClickHandler(event, /^mailto:/), true);
            }

            // Everything's done, so now we're able to settle for a height.
            iframe.style.height = iframeDoc.body.scrollHeight+"px";

            // Sometimes setting the iframe's content and height changes
            // the scroll value, don't know why.
            if (originalScroll)
              self._domNode.ownerDocument.documentElement.scrollTop = originalScroll;

            self._didStream = true;
            self._signal();
          } catch (e) {
            Log.warn(e, "(are you running comm-central?)");
            Log.warn("Running signal once more to make sure we move on with our life... (warning, this WILL cause bugs)");
            dumpCallStack(e);
            self._didStream = true;
            self._signal();
          }
        }, true); /* end iframe.addEventListener */

        /* Unbelievable as it may seem, the code below works.
         * Some references :
         * - http://mxr.mozilla.org/comm-central/source/mailnews/base/src/nsMessenger.cpp#564
         * - http://mxr.mozilla.org/comm-central/source/mailnews/base/src/nsMessenger.cpp#388
         * - https://developer.mozilla.org/@api/deki/files/3579/=MessageRepresentations.png
         *
         * According to dmose, we should get the regular content policy
         * for free (regarding image loading, JS...) by using a content
         * iframe with a classical call to loadURI. AFAICT, this works
         * pretty well (no JS is executed, the images are loaded IFF we
         * authorized that recipient).
         * */
        let url = msgHdrToNeckoURL(self._msgHdr);

        /* These steps are mandatory. Basically, the code that loads the
         * messages will always output UTF-8 as the OUTPUT ENCODING, so
         * we need to tell the iframe's docshell about it. */
        let cv = iframe.docShell.contentViewer;
        cv.QueryInterface(Ci.nsIMarkupDocumentViewer);
        cv.hintCharacterSet = "UTF-8";
        cv.hintCharacterSetSource = kCharsetFromMetaTag;
        /* Is this even remotely useful? */
        iframe.docShell.appType = Components.interfaces.nsIDocShell.APP_TYPE_MAIL;

        /* Now that's about the input encoding. Here's the catch: the
         * right way to do that would be to query nsIMsgI18NUrl [1] on the
         * nsIURI and set charsetOverRide on it. For this parameter to
         * take effect, we would have to pass the nsIURI to LoadURI, not a
         * string as in url.spec, but a real nsIURI. Next step:
         * nsIWebNavigation.loadURI only takes a string... so let's have a
         * look at nsIDocShell... good, loadURI takes a a nsIURI there.
         * BUT IT'S [noscript]!!! I'm doomed.
         *
         * Workaround: call DisplayMessage that in turns calls the
         * docShell from C++ code. Oh and why are we doing this? Oh, yes,
         * see [2].
         *
         * Some remarks: I don't know if the nsIUrlListener [3] is useful,
         * but let's leave it like that, it might come in handy later. And
         * we _cannot instanciate directly_ the nsIMsgMessageService because
         * there are different ones for each type of account. So we must ask
         * nsIMessenger for it, so that it instanciates the right component.
         *
        [1] http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIMsgMailNewsUrl.idl#172
        [2] https://www.mozdev.org/bugs/show_bug.cgi?id=22775
        [3] http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIUrlListener.idl#48
        [4] http://mxr.mozilla.org/comm-central/source/mailnews/base/public/nsIMsgMessageService.idl#112
        */
        let messageService = gMessenger.messageServiceFromURI(url.spec);
        let urlListener = {
          OnStartRunningUrl: function () {},
          OnStopRunningUrl: function () {},
          QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports, Ci.nsIUrlListener])
        };
 
        /**
        * When you want a message displayed....
        *
        * @param in aMessageURI Is a uri representing the message to display.
        * @param in aDisplayConsumer Is (for now) an nsIDocShell which we'll use to load 
        *                         the message into.
        *                         XXXbz Should it be an nsIWebNavigation or something?
        * @param in aMsgWindow
        * @param in aUrlListener
        * @param in aCharsetOverride (optional) character set override to force the message to use.
        * @param out aURL
        */
        messageService.DisplayMessage(self._uri, iframe.docShell, msgWindow,
                                      urlListener, aCharset, {});
      } catch (e) {
        Log.error(e);
        dumpCallStack(e);
      }
    }, true); /* end document.addEventListener */

    // Ok, brace ourselves for notifications happening during the message load
    //  process.
    addMsgListener(this);

    // This triggers the whole process. We assume (see beginning) that the
    // message is expanded which means the <iframe> will be visible right away
    // which means we can use offsetHeight, getComputedStyle and stuff on it.
    let container = this._domNode.getElementsByClassName("iframe-container")[0];
    container.appendChild(iframe);
  }
}

function MessageFromGloda(aConversation, aGlodaMsg) {
  this._msgHdr = aGlodaMsg.folderMessage;
  this._glodaMsg = aGlodaMsg;
  Message.apply(this, arguments);

  // Our gloda plugin found something for us, thanks dude!
  if (aGlodaMsg.alternativeSender) {
    this._realFrom = this._from;
    this._from = this.parse(aGlodaMsg.alternativeSender)[0];
  }

  // FIXME messages that have no body end up with "..." as a snippet
  this._snippet = aGlodaMsg._indexedBodyText
    ? aGlodaMsg._indexedBodyText.substring(0, snippetLength-1)
    : "..."; // it's probably an Enigmail message

  if ("attachmentInfos" in aGlodaMsg)
    this._attachments = aGlodaMsg.attachmentInfos;

  this._signal();
}

MessageFromGloda.prototype = {
  __proto__: Message.prototype,
}

MixIn(MessageFromGloda, Message);

function MessageFromDbHdr(aConversation, aMsgHdr) {
  this._msgHdr = aMsgHdr;
  Message.apply(this, arguments);

  // Gloda is not with us, so stream the message... the MimeMsg API says that
  //  the streaming will fail and the underlying exception will be re-thrown in
  //  case the message is not on disk. In that case, the fallback is to just get
  //  the body text and wait for it to be ready. This can be SLOW (like, real
  //  slow). But at least it works. (Setting the fourth parameter to true just
  //  leads to an empty snippet).
  let self = this;
  Log.warn("Streaming the message because Gloda has not indexed it, this is BAD");
  try {
    MsgHdrToMimeMessage(aMsgHdr, null, function(aMsgHdr, aMimeMsg) {
      if (aMimeMsg == null) {
        self._fallbackSnippet();
        return;
      }

      let [text, meta] = mimeMsgToContentSnippetAndMeta(aMimeMsg, aMsgHdr.folder, snippetLength);
      self._snippet = text;
      if ("x-bugzilla-who" in aMimeMsg.headers) {
        self._realFrom = self._from;
        self._from = self.parse(aMimeMsg.headers["x-bugzilla-who"])[0];
      }

      self._attachments = aMimeMsg.allUserAttachments
        .filter(function (x) x.isRealAttachment);

      self._signal();
    }, true);
  } catch (e) {
    // Remember: these exceptions don't make it out of the callback (XPConnect
    // death trap, can't fight it until we reach level 3 and gain 1200 exp
    // points, so keep training)
    Log.warn("Gloda failed to stream the message properly, this is VERY BAD");
    Log.warn(e);
    this._fallbackSnippet();
  }
}

MessageFromDbHdr.prototype = {
  __proto__: Message.prototype,

  _fallbackSnippet: function _MessageFromDbHdr_fallbackSnippet () {
    let body = msgHdrToMessageBody(this._msgHdr, true, snippetLength);
    this._snippet = body.substring(0, snippetLength-1);
    this._signal();
  },
}

MixIn(MessageFromDbHdr, Message);
