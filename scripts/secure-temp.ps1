param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = "Stop"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.User
$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($owner, $system)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $Directory -AclObject $acl
$actual = Get-Acl -LiteralPath $Directory
if (-not $actual.AreAccessRulesProtected) { throw "Temporary ACL inheritance remained enabled" }
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) { throw "Temporary directory owner mismatch" }
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin @($owner.Value, $system.Value)) { throw "Unexpected temporary directory access rule" }
}
