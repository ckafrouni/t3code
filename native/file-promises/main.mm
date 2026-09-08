#import <Cocoa/Cocoa.h>
#include <node_api.h>
#include <string>

static napi_threadsafe_function events;
static NSMutableDictionary<NSString *, id> *sources;
static NSMutableDictionary<NSString *, void (^)(NSError *)> *completions;
static void Emit(NSDictionary *value) {
  if (!events)
    return;
  NSData *json = [NSJSONSerialization dataWithJSONObject:value
                                                 options:0
                                                   error:nil];
  char *copy = strdup([[NSString alloc] initWithData:json
                                            encoding:NSUTF8StringEncoding]
                          .UTF8String);
  napi_call_threadsafe_function(events, copy, napi_tsfn_nonblocking);
}
static void CallJS(napi_env env, napi_value callback, void *, void *data) {
  if (env) {
    napi_value text, global, result;
    napi_create_string_utf8(env, (char *)data, NAPI_AUTO_LENGTH, &text);
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, 1, &text, &result);
  }
  free(data);
}
static NSString *String(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string text(length + 1, '\0');
  napi_get_value_string_utf8(env, value, text.data(), text.size(), &length);
  return [[NSString alloc] initWithBytes:text.data()
                                  length:length
                                encoding:NSUTF8StringEncoding];
}
@interface T3PromiseSource
    : NSObject <NSDraggingSource, NSFilePromiseProviderDelegate>
@property(copy) NSString *identifier;
@property(strong) NSArray<NSFilePromiseProvider *> *providers;
@end
@implementation T3PromiseSource
- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}
- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession *)session {
  return YES;
}
- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)provider
                  fileNameForType:(NSString *)type {
  return provider.userInfo[@"name"];
}
- (NSOperationQueue *)operationQueueForFilePromiseProvider:
    (NSFilePromiseProvider *)provider {
  return NSOperationQueue.mainQueue;
}
- (void)filePromiseProvider:(NSFilePromiseProvider *)provider
          writePromiseToURL:(NSURL *)url
          completionHandler:(void (^)(NSError *))completionHandler {
  NSString *request = [NSString
      stringWithFormat:@"%@:%@", self.identifier, provider.userInfo[@"index"]];
  completions[request] = [completionHandler copy];
  Emit(@{
    @"type" : @"write",
    @"sessionId" : self.identifier,
    @"requestId" : request,
    @"index" : provider.userInfo[@"index"],
    @"destination" : url.path
  });
}
- (void)draggingSession:(NSDraggingSession *)session
           endedAtPoint:(NSPoint)point
              operation:(NSDragOperation)operation {
  Emit(@{
    @"type" : @"ended",
    @"sessionId" : self.identifier,
    @"cancelled" : @(operation == NSDragOperationNone)
  });
  if (operation == NSDragOperationNone)
    [sources removeObjectForKey:self.identifier];
}
@end
static napi_value Configure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], name;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (events)
    napi_release_threadsafe_function(events, napi_tsfn_abort);
  napi_create_string_utf8(env, "T3 file promises", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, args[0], nullptr, name, 0, 1, nullptr,
                                  nullptr, nullptr, CallJS, &events);
  napi_unref_threadsafe_function(env, events);
  sources = [NSMutableDictionary new];
  completions = [NSMutableDictionary new];
  return nullptr;
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void *handle;
  size_t length;
  napi_get_buffer_info(env, args[0], &handle, &length);
  if (length != sizeof(void *)) {
    napi_throw_error(env, nullptr, "Invalid native window handle.");
    return nullptr;
  }
  NSView *view = (__bridge NSView *)(*(void **)handle);
  NSString *identifier = String(env, args[1]);
  NSData *json = [String(env, args[2]) dataUsingEncoding:NSUTF8StringEncoding];
  NSArray *items = [NSJSONSerialization JSONObjectWithData:json
                                                   options:0
                                                     error:nil];
  if (!view.window || !items.count) {
    napi_throw_error(env, nullptr, "No window or files available for drag.");
    return nullptr;
  }
  T3PromiseSource *source = [T3PromiseSource new];
  source.identifier = identifier;
  NSMutableArray *providers = [NSMutableArray new],
                 *draggingItems = [NSMutableArray new];
  NSUInteger index = 0;
  NSPoint location =
      [view convertPoint:view.window.mouseLocationOutsideOfEventStream
                fromView:nil];
  for (NSDictionary *item in items) {
    BOOL directory = [item[@"directory"] boolValue];
    NSFilePromiseProvider *provider = [[NSFilePromiseProvider alloc]
        initWithFileType:directory ? @"public.folder" : @"public.data"
                delegate:source];
    provider.userInfo = @{@"name" : item[@"name"], @"index" : @(index++)};
    [providers addObject:provider];
    NSDraggingItem *drag =
        [[NSDraggingItem alloc] initWithPasteboardWriter:provider];
    NSImage *icon = [[NSWorkspace sharedWorkspace]
        iconForFileType:directory ? NSFileTypeForHFSTypeCode(kGenericFolderIcon)
                                  : [item[@"name"] pathExtension]];
    [drag setDraggingFrame:NSMakeRect(location.x, location.y, 32, 32)
                  contents:icon];
    [draggingItems addObject:drag];
  }
  source.providers = providers;
  sources[identifier] = source;
  NSEvent *event = NSApp.currentEvent;
  if (event.type != NSEventTypeLeftMouseDragged &&
      event.type != NSEventTypeLeftMouseDown)
    event = [NSEvent
        mouseEventWithType:NSEventTypeLeftMouseDragged
                  location:view.window.mouseLocationOutsideOfEventStream
             modifierFlags:0
                 timestamp:NSProcessInfo.processInfo.systemUptime
              windowNumber:view.window.windowNumber
                   context:nil
               eventNumber:0
                clickCount:1
                  pressure:1];
  NSDraggingSession *session = [view beginDraggingSessionWithItems:draggingItems
                                                             event:event
                                                            source:source];
  session.animatesToStartingPositionsOnCancelOrFail = YES;
  return nullptr;
}
static napi_value Finish(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  NSString *request = String(env, args[0]), *message = String(env, args[1]);
  void (^completion)(NSError *) = completions[request];
  if (completion) {
    [completions removeObjectForKey:request];
    completion(message.length
                   ? [NSError
                         errorWithDomain:@"T3FileTransfer"
                                    code:1
                                userInfo:@{NSLocalizedDescriptionKey : message}]
                   : nil);
  }
  return nullptr;
}
static napi_value Dispose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  NSString *identifier = String(env, args[0]);
  for (NSString *key in [completions.allKeys copy])
    if ([key hasPrefix:[identifier stringByAppendingString:@":"]]) {
      void (^completion)(NSError *) = completions[key];
      [completions removeObjectForKey:key];
      completion([NSError errorWithDomain:NSCocoaErrorDomain
                                     code:NSUserCancelledError
                                 userInfo:nil]);
    }
  [sources removeObjectForKey:identifier];
  return nullptr;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"configure", nullptr, Configure, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"finish", nullptr, Finish, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default,
       nullptr}};
  napi_define_properties(env, exports, 4, descriptors);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
