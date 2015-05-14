// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var Crypto = Npm.require("crypto");
var Capnp = Npm.require("capnp");

var HandlePersistent = Capnp.importSystem("sandstorm/supervisor.capnp").HandlePersistent;
var SandstormCore = Capnp.importSystem("sandstorm/supervisor.capnp").SandstormCore;
var SandstormCoreFactory = Capnp.importSystem("sandstorm/backend.capnp").SandstormCoreFactory;
var OngoingNotificationPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").OngoingNotificationPersistent;

function SandstormCoreImpl(grainId) {
  this.grainId = grainId;
}

var makeSandstormCore = function (grainId) {
  return new Capnp.Capability(new SandstormCoreImpl(grainId), SandstormCore);
};

function NotificationHandle(notificationId) {
  this.notificationId = notificationId;
}

function makeNotificationHandle(notificationId) {
  return new Capnp.Capability(new NotificationHandle(notificationId), HandlePersistent);
}

function dropWakelock(grainId, wakeLockNotificationId) {
  // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
  // We have to explicitly copy it before we can pass it on to node-capnp.
  var copiedId = new Buffer(wakeLockNotificationId);
  waitPromise(openGrain(grainId).supervisor.drop({wakeLockNotification: copiedId}).catch(function (err) {
    if (shouldRestartGrain(err, 0)) {
      return openGrain(grainId, true).supervisor.drop({wakeLockNotification: copiedId});
    }
  }));
}

function dismissNotification(notificationId) {
  var notification = Notifications.findOne({_id: notificationId});
  if (notification) {
    Notifications.remove({_id: notificationId});
    if (notification.ongoing) {
      // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
      // Only way to fix seems to be to copy it.
      dropToken(notification.grainId, new Buffer(notification.ongoing));
    }
  }
}

function tryDropNotification(notificationId) {
  // TODO(soon): This has serious timing issues with Mongo, since we're relying on it for refcounting
  // Typically a notification handle will be saved and then immediately closed by the caller.
  // This means that if Mongo doesn't actually find the ApiToken that was just stored, this method
  // will dismiss the notification even though it was meant to be persisted.
  var token = ApiTokens.findOne({"frontendRef.notificationHandle": notificationId});
  if (!token) {
    dismissNotification(notificationId);
  }
}

Meteor.methods({
  dismissNotification: function (notificationId) {
    var notification = Notifications.findOne({_id: notificationId});
    if (!notification) {
      throw new Meteor.Error(404, "Notification id not found.");
    } else if (notification.userId !== Meteor.userId()) {
      throw new Meteor.Error(403, "Notification does not belong to current user.");
    } else {
      dismissNotification(notificationId);
    }
  },
  readAllNotifications: function () {
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "User not logged in.");
    }
    Notifications.update({userId: Meteor.userId()}, {$set: {isUnread: false}}, {multi: true});
  }
});

NotificationHandle.prototype.close = function () {
  var self = this;
  return inMeteor(function () {
    tryDropNotification(self.notificationId);
  });
};

NotificationHandle.prototype.save = function () {
  var self = this;
  return inMeteor(function () {
    var sturdyRef = new Buffer(Random.id(20));
    var hashedSturdyRef = Crypto.createHash("sha256").update(sturdyRef).digest("base64");
    ApiTokens.insert({
      _id: hashedSturdyRef,
      frontendRef: {
        notificationHandle: self.notificationId
      }
    });
    return {sturdyRef: sturdyRef};
  });
};

SandstormCoreImpl.prototype.restore = function (sturdyRef) {
  var self = this;
  return inMeteor(function () {
    var hashedSturdyRef = Crypto.createHash("sha256").update(sturdyRef).digest("base64");
    var token = ApiTokens.findOne(hashedSturdyRef);
    if (!token) {
      throw new Error("No token found to restore");
    }
    if (token.frontendRef) {
      var notificationId = token.frontendRef.notificationHandle;
      return {cap: makeNotificationHandle(notificationId)};
    } else if (token.objectId) {
      return waitPromise(openGrain(self.grainId).supervisor.restore(token.objectId).catch(function (err) {
        if (shouldRestartGrain(err, 0)) {
          return openGrain(grainId, true).supervisor.restore(token.objectId);
        }
      }));
    } else {
      throw new Error("Unknown token type.");
    }
  });
};

var dropToken = function (grainId, sturdyRef) {
  var hashedSturdyRef = Crypto.createHash("sha256").update(sturdyRef).digest("base64");
  var token = ApiTokens.findOne({_id: hashedSturdyRef});
  if (!token) {
    return;
  }
  if (token.frontendRef) {
    var notificationId = token.frontendRef.notificationHandle;
    ApiTokens.remove({_id: hashedSturdyRef});
    tryDropNotification(notificationId);
  } else if (token.objectId) {
    dropWakelock(grainId, token.objectId.wakeLockNotification);
  } else {
    throw new Error("Unknown token type.");
  }
};

SandstormCoreImpl.prototype.drop = function (sturdyRef) {
  var self = this;
  return inMeteor(function () {
    dropToken(self.grainId, sturdyRef);
  });
};

SandstormCoreImpl.prototype.makeToken = function (ref, owner) {
  var self = this;
  return inMeteor(function () {
    var sturdyRef = new Buffer(Random.id(20));
    var hashedSturdyRef = Crypto.createHash("sha256").update(sturdyRef).digest("base64");
    // TODO(soon): should userId be filled?
    ApiTokens.insert({
      _id: hashedSturdyRef,
      grainId: self.grainId,
      objectId: ref,
      owner: owner
    });

    return {
      token: sturdyRef
    };
  });
};

SandstormCoreImpl.prototype.getOwnerNotificationTarget = function() {
  var grainId = this.grainId;
  return {owner: {addOngoing: function(displayInfo, notification) {
    return inMeteor(function () {
      var grain = Grains.findOne({_id: grainId});
      if (!grain) {
        throw new Error("Grain not found.");
      }
      var castedNotification = notification.castAs(OngoingNotificationPersistent);
      var wakelockToken = waitPromise(castedNotification.save()).sturdyRef;

      // We have to close both the casted cap and the original. Perhaps this should be fixed in
      // node-capnp?
      castedNotification.close();
      notification.close();
      var notificationId = Notifications.insert({
        ongoing: wakelockToken,
        grainId: grainId,
        userId: grain.userId,
        text: displayInfo.caption,
        timestamp: new Date(),
        isUnread: true
      });

      return {handle: makeNotificationHandle(notificationId)};
    });
  }}};
};

function SandstormCoreFactoryImpl() {
}

SandstormCoreFactoryImpl.prototype.getSandstormCore = function (grainId){
  return {core: makeSandstormCore(grainId)};
};

makeSandstormCoreFactory = function () {
  return new Capnp.Capability(new SandstormCoreFactoryImpl(), SandstormCoreFactory);
};
