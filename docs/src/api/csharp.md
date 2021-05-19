## method: Request.PostDataJSON
* langs: csharp
- returns: <[JsonDocument]>

Returns parsed request's body for `form-urlencoded` and JSON as a fallback if any.

When the response is `application/x-www-form-urlencoded` then a key/value object of the values will be returned.
Otherwise it will be parsed as JSON.

### param: ElementHandle.selectOption.values = %%-csharp-select-options-values-%%
### param: ElementHandle.setInputFiles.files = %%-csharp-input-files-%%

### param: Frame.selectOption.values = %%-csharp-select-options-values-%%
### param: Frame.setInputFiles.files = %%-csharp-input-files-%%

### param: Page.selectOption.values = %%-csharp-select-options-values-%%
### param: Page.setInputFiles.files = %%-csharp-input-files-%%
