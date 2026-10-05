// Loaded only into com.fido.asm. The bundle is built with frida-java-bridge.
// This hook handles CTAP getAssertion from Xiaomi's QR authenticator.
import Java from 'frida-java-bridge';

Java.perform(() => {
  const LocalStrategy = Java.use('m2.d');
  const GetAssertion = Java.use('b3.n');
  const Descriptor = Java.use('d3.j');
  const QrActivity = Java.use('com.fido.fido2.ui.QRAuthenticatorActivity');
  const Bundle = Java.use('android.os.Bundle');
  const Intent = Java.use('android.content.Intent');
  const Base64 = Java.use('android.util.Base64');
  const CredentialOptionBuilder = Java.use('android.credentials.CredentialOption$Builder');
  const GetRequestBuilder = Java.use('android.credentials.GetCredentialRequest$Builder');
  const CredentialManager = Java.use('android.credentials.CredentialManager');
  const OutcomeReceiver = Java.use('android.os.OutcomeReceiver');
  const GetResponse = Java.use('android.credentials.GetCredentialResponse');
  const GetException = Java.use('android.credentials.GetCredentialException');
  const Collections = Java.use('java.util.Collections');
  const Log = Java.use('android.util.Log');
  const PrepareResponse = Java.use('android.credentials.PrepareGetCredentialResponse');
  const getFromHandle = CredentialManager.getCredential.overload('android.content.Context',
    'android.credentials.PrepareGetCredentialResponse$PendingGetCredentialHandle',
    'android.os.CancellationSignal', 'java.util.concurrent.Executor', 'android.os.OutcomeReceiver');
  const pending = new Map(); // id -> CTAP callback, until a result is delivered
  const sessions = new Map(); // id -> request state while probing/dispatching
  let nextId = 1;

  const TYPE = 'androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL';
  const SUBTYPE = 'androidx.credentials.BUNDLE_KEY_SUBTYPE';
  const GET_SUBTYPE = 'androidx.credentials.BUNDLE_VALUE_SUBTYPE_GET_PUBLIC_KEY_CREDENTIAL_OPTION';
  const REQUEST_JSON = 'androidx.credentials.BUNDLE_KEY_REQUEST_JSON';
  const CLIENT_HASH = 'androidx.credentials.BUNDLE_KEY_CLIENT_DATA_HASH';
  const RESPONSE_JSON = 'androidx.credentials.BUNDLE_KEY_AUTHENTICATION_RESPONSE_JSON';
  const B64_FLAGS = 11; // URL_SAFE | NO_WRAP | NO_PADDING
  // HyperOS's selector closes without notifying the caller when no provider has an
  // entry, so answer the PC ourselves rather than leave it waiting.
  const RESULT_TIMEOUT_MS = 90000; // leaves time to unlock Bitwarden
  const UNLOCK_POLL_MS = 1500;
  const REFOCUS_DELAY_MS = 500;
  const BITWARDEN = 'com.x8bit.bitwarden';

  // Fixed markers only; the injector detaches, so logcat is the only sink.
  function log(marker) {
    Log.i('HyprosBitwarden', marker);
  }

  function bytes(values) {
    return Java.array('byte', Array.from(values, n => n > 127 ? n - 256 : n));
  }

  function unsigned(values) {
    return Array.from(values, n => n & 255);
  }

  function base64Url(values) {
    return Base64.encodeToString(bytes(values), B64_FLAGS).toString();
  }

  function decodeBase64Url(value) {
    if (typeof value !== 'string' || !value.length) throw new Error('missing response field');
    return unsigned(Base64.decode(value, B64_FLAGS));
  }

  function pushCborHeader(out, major, length) {
    if (length < 24) out.push((major << 5) | length);
    else if (length < 256) out.push((major << 5) | 24, length);
    else if (length < 65536) out.push((major << 5) | 25, length >> 8, length & 255);
    else throw new Error('oversized CBOR item');
  }

  function pushCborBytes(out, value) {
    pushCborHeader(out, 2, value.length);
    out.push(...value);
  }

  function pushCborText(out, value) {
    const encoded = unsigned(Java.use('java.lang.String').$new(value).getBytes('UTF-8'));
    pushCborHeader(out, 3, encoded.length);
    out.push(...encoded);
  }

  function assertionResponse(jsonText) {
    const credential = JSON.parse(jsonText);
    const response = credential.response;
    if (!response) throw new Error('missing response object; keys=' + Object.keys(credential));
    const id = decodeBase64Url(credential.rawId || credential.id);
    const authData = decodeBase64Url(response.authenticatorData);
    const signature = decodeBase64Url(response.signature);
    const userHandle = response.userHandle ? decodeBase64Url(response.userHandle) : null;
    const out = [0]; // CTAP2 success
    pushCborHeader(out, 5, userHandle === null ? 3 : 4);
    out.push(1); // credential descriptor
    pushCborHeader(out, 5, 2); // CTAP2 canonical order: shorter keys first
    pushCborText(out, 'id');
    pushCborBytes(out, id);
    pushCborText(out, 'type');
    pushCborText(out, 'public-key');
    out.push(2);
    pushCborBytes(out, authData);
    out.push(3);
    pushCborBytes(out, signature);
    if (userHandle !== null) {
      out.push(4);
      pushCborHeader(out, 5, 1);
      pushCborText(out, 'id');
      pushCborBytes(out, userHandle);
    }
    return bytes(out);
  }

  function ctapError(type) {
    if (type.endsWith('TYPE_NO_CREDENTIAL')) return 0x2e; // CTAP2_ERR_NO_CREDENTIALS
    if (type.endsWith('TYPE_USER_CANCELED')) return 0x27; // CTAP2_ERR_OPERATION_DENIED
    return 0x7f; // CTAP1_ERR_OTHER
  }

  function activityFrom(strategy) {
    // QRAuthenticatorActivity.b extends m2.d and captures its parent Activity;
    // R8 renamed the synthetic this$0 field, so find it by type.
    const fields = strategy.getClass().getDeclaredFields();
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!QrActivity.class.isAssignableFrom(field.getType())) continue;
      field.setAccessible(true);
      const activity = Java.cast(field.get(strategy), QrActivity);
      return activity.isFinishing() || activity.isDestroyed() ? null : activity;
    }
    throw new Error('QR activity field not found');
  }

  // Obfuscated field names (a, b, c...) can collide with method names; Frida then
  // exposes the field with a leading underscore.
  function field(object, name) {
    const holder = object['_' + name] || object[name];
    if (!holder || !('value' in holder)) throw new Error('missing field ' + name);
    return holder.value;
  }

  function requestFrom(raw) {
    const request = Java.cast(raw, GetAssertion);
    const rpId = field(request, 'b').toString(); // rpId
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(rpId) || rpId.includes('..')) {
      throw new Error('invalid RP ID');
    }
    const clientHash = field(request, 'a'); // clientDataHash
    if (!clientHash || clientHash.length !== 32) throw new Error('invalid client data hash');
    const publicKey = { rpId, challenge: base64Url(clientHash) };
    const allow = field(request, 'c'); // allowList: List<d3.j>
    if (allow !== null && allow.size() > 0) {
      publicKey.allowCredentials = [];
      for (let i = 0; i < allow.size(); i++) {
        const descriptor = Java.cast(allow.get(i), Descriptor);
        publicKey.allowCredentials.push({ type: 'public-key', id: base64Url(field(descriptor, 'id')) });
      }
    }
    const options = field(request, 'e'); // n$a {a: up, b: uv}
    if (options !== null) {
      const uv = field(options, 'b');
      if (uv !== null) publicKey.userVerification = uv.booleanValue() ? 'required' : 'discouraged';
    }
    return { rpId, clientHash, json: JSON.stringify(publicKey) };
  }

  const Receiver = Java.registerClass({
    name: 'com.fido.asm.HyprosBitwardenReceiver',
    implements: [OutcomeReceiver],
    fields: { requestId: 'int' },
    methods: {
      onResult(result) {
        const id = this.requestId.value;
        const callback = pending.get(id);
        pending.delete(id);
        sessions.delete(id);
        if (!callback) return;
        let stage = 'credential';
        try {
          // OutcomeReceiver is generic, so the bridge hands us a plain Object.
          const credential = Java.cast(result, GetResponse).getCredential();
          const data = credential.getData();
          stage = 'type=' + credential.getType() + ' keys=' + data.keySet().toString();
          const json = data.getString(RESPONSE_JSON);
          if (json === null) throw new Error('no response JSON');
          stage += ' json';
          callback.a(assertionResponse(json.toString()));
          log('HYPROS_GET_SUCCESS');
        } catch (error) {
          callback.b(127);
          // Key names and error text only; never values, which hold credential material.
          log('HYPROS_GET_CONVERSION_ERROR:' + stage + ':' + (error.name || 'Error') + ':' +
              String(error.message).slice(0, 160));
        }
      },
      onError(error) {
        const id = this.requestId.value;
        const callback = pending.get(id);
        pending.delete(id);
        sessions.delete(id);
        const type = Java.cast(error, GetException).getType().toString();
        if (callback) callback.b(ctapError(type));
        // Do not log exception messages: they can contain credential metadata.
        log('HYPROS_GET_PROVIDER_ERROR:' + type);
      }
    }
  });

  function finish(id, code, marker) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    pending.delete(id);
    session.callback.b(code);
    log(marker);
  }

  // Xiaomi's selector only renders credential entries: a locked provider's unlock entry makes
  // it close silently. So probe first, and if only unlock entries exist, open Bitwarden and
  // re-probe until the vault is unlocked.
  function probe(id) {
    const session = sessions.get(id);
    if (!session) return;
    const receiver = PrepareReceiver.$new();
    receiver.requestId.value = id;
    session.manager.prepareGetCredential(session.request, null, session.activity.getMainExecutor(), receiver);
  }

  function launchUnlock(session) {
    const intent = session.activity.getPackageManager().getLaunchIntentForPackage(BITWARDEN);
    if (intent === null) throw new Error('Bitwarden launcher not found');
    session.activity.startActivity(intent);
    log('HYPROS_UNLOCK_REQUESTED');
  }

  function bringToFront(session) {
    const intent = Intent.$new();
    intent.setComponent(session.activity.getComponentName());
    intent.addFlags(0x20000); // FLAG_ACTIVITY_REORDER_TO_FRONT
    session.activity.startActivity(intent);
    log('HYPROS_REFOCUSED');
  }

  // The hybrid tunnel ends with the QR activity; don't revive it or show a picker for nothing.
  function sessionGone(id, session) {
    if (!session.activity.isFinishing() && !session.activity.isDestroyed()) return false;
    finish(id, 0x7f, 'HYPROS_SESSION_GONE');
    return true;
  }

  // Opens the picker from the probe's result, so providers aren't queried a second time.
  function select(id, handle) {
    const session = sessions.get(id);
    if (!session || sessionGone(id, session)) return;
    const receiver = Receiver.$new();
    receiver.requestId.value = id;
    getFromHandle.call(session.manager, session.activity, handle, null,
      session.activity.getMainExecutor(), receiver);
    log('HYPROS_GET_DISPATCHED');
  }

  const PrepareReceiver = Java.registerClass({
    name: 'com.fido.asm.HyprosBitwardenPrepareReceiver',
    implements: [OutcomeReceiver],
    fields: { requestId: 'int' },
    methods: {
      onResult(result) {
        const id = this.requestId.value;
        const session = sessions.get(id);
        if (!session || sessionGone(id, session)) return;
        try {
          const prepared = Java.cast(result, PrepareResponse);
          if (prepared.hasCredentialResults(TYPE)) {
            const handle = Java.retain(prepared.getPendingGetCredentialHandle());
            if (session.unlockLaunched) {
              // Bitwarden is still in front; the selector launch would be blocked as a
              // background activity start, so bring the QR screen back first.
              bringToFront(session);
              setTimeout(() => Java.perform(() => select(id, handle)), REFOCUS_DELAY_MS);
            } else {
              select(id, handle);
            }
          } else if (prepared.hasAuthenticationResults()) {
            if (!session.unlockLaunched) {
              session.unlockLaunched = true;
              launchUnlock(session);
            }
            setTimeout(() => Java.perform(() => probe(id)), UNLOCK_POLL_MS);
          } else {
            finish(id, 0x2e, 'HYPROS_GET_NO_CREDENTIALS'); // CTAP2_ERR_NO_CREDENTIALS
          }
        } catch (error) {
          finish(id, 0x7f, 'HYPROS_PREPARE_ERROR:' + (error.name || 'Error') + ':' +
              String(error.message).slice(0, 160));
        }
      },
      onError(error) {
        const type = Java.cast(error, GetException).getType().toString();
        finish(this.requestId.value, ctapError(type), 'HYPROS_PREPARE_PROVIDER_ERROR:' + type);
      }
    }
  });

  // Hands a parsed getAssertion to Android Credential Manager; the result goes to callback.
  function dispatch(activity, request, callback) {
    const data = Bundle.$new();
    data.putString(SUBTYPE, GET_SUBTYPE);
    data.putString(REQUEST_JSON, request.json);
    data.putByteArray(CLIENT_HASH, request.clientHash);
    const option = CredentialOptionBuilder.$new(TYPE, data, Bundle.$new(data)).build();
    const frameworkRequest = GetRequestBuilder.$new(Bundle.$new())
      .setCredentialOptions(Collections.singletonList(option))
      .setAlwaysSendAppInfoToProvider(true)
      .setOrigin('https://' + request.rpId)
      .build();
    // The activity overrides getSystemService(String), which hides the Class overload.
    const service = activity.getSystemService('credential');
    if (service === null) throw new Error('CredentialManager unavailable');
    const id = nextId++;
    const retained = Java.retain(callback);
    pending.set(id, retained);
    sessions.set(id, {
      activity: Java.retain(activity),
      manager: Java.retain(Java.cast(service, CredentialManager)),
      request: Java.retain(frameworkRequest),
      callback: retained,
      unlockLaunched: false
    });
    try {
      probe(id);
    } catch (error) {
      sessions.delete(id);
      pending.delete(id);
      throw error;
    }
    setTimeout(() => Java.perform(() => finish(id, 0x2e, 'HYPROS_GET_TIMEOUT')), RESULT_TIMEOUT_MS);
  }

  const boundary = LocalStrategy.h.overloads[0];
  if (LocalStrategy.h.overloads.length !== 1 ||
      boundary.argumentTypes[0].className !== 'j2.h' ||
      boundary.argumentTypes[1].className !== 'b3.m0') {
    throw new Error('unexpected FIDO method signature');
  }
  boundary.implementation = function (executor, rawRequest, callback) {
    if (!GetAssertion.class.isInstance(rawRequest)) {
      return boundary.call(this, executor, rawRequest, callback);
    }
    try {
      const activity = activityFrom(this);
      if (!activity) return boundary.call(this, executor, rawRequest, callback);
      dispatch(activity, requestFrom(rawRequest), callback);
      // Xiaomi's "Performing security verification" dialog stays up until its own UI replaces
      // it, which never happens here, and its 30 s watchdog would cancel the session.
      Java.scheduleOnMainThread(() => activity.dismissLoadingDialog());
    } catch (error) {
      callback.b(127);
      log('HYPROS_GET_DISPATCH_ERROR:' + (error.name || 'Error') + ':' + String(error.message).slice(0, 200));
    }
  };
  log('HYPROS_HOOK_READY');
});
