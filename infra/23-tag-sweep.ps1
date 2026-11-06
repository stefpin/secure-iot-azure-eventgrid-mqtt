<#
    Step 23 - tag sweep. Azure creates some resources implicitly (Application Insights smart
    detector rules, private-endpoint NICs, ...). Merge CostControl=Ignore (and the purpose tag)
    onto everything in the demo resource group that lacks it. Existing tags are never removed.
#>
. "$PSScriptRoot\env.ps1"
$tags = @{}; foreach ($t in $Demo.Tags) { $k, $v = $t -split '=', 2; $tags[$k] = $v }
$all = @(Invoke-Az resource list -g $Demo.ResourceGroup -o json)
$todo = @($all | Where-Object { -not $_.tags -or $_.tags.CostControl -ne 'Ignore' })
foreach ($r in $todo) {
    Assert-DemoScope $r.id
    Invoke-Az tag update --resource-id $r.id --operation Merge --tags @($Demo.Tags) -o none | Out-Null
    Write-Ok "tagged $($r.type) $($r.name)"
}
$rgTags = (Invoke-Az group show -n $Demo.ResourceGroup -o json).tags
if (-not $rgTags -or $rgTags.CostControl -ne 'Ignore') {
    Invoke-Az tag update --resource-id $Demo.RgId --operation Merge --tags 'CostControl=Ignore' -o none | Out-Null
    Write-Ok 'tagged the resource group'
}
Write-Ok "$($all.Count - $todo.Count) of $($all.Count) resources already tagged, $($todo.Count) updated"
